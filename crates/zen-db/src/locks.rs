//! Per-query lock telemetry — sidecar samplers for Postgres + MSSQL.
//!
//! Locks are ephemeral: they live in `pg_locks` / `sys.dm_tran_locks`
//! only for as long as the executing session holds them, and they
//! disappear the moment the transaction commits. EXPLAIN doesn't ship
//! lock info on either engine, so the only way to surface "what
//! granularity did this query lock at?" is to **observe from the
//! side** while the query runs — open a second connection, capture
//! the executing session's PID/SPID, and poll the lock catalogue at a
//! tight interval until the user statement returns.
//!
//! This module ships two sampler types:
//!
//! - [`PgLockSampler::start`] — opens a fresh `PgPool` of size 1
//!   against the same options as the user connection, polls
//!   `pg_locks` JOIN `pg_stat_activity` for the captured backend
//!   PID, and aggregates the samples into a [`LockSummary`].
//!
//! - [`MsSqlLockSampler::start`] — opens a fresh `tiberius::Client`
//!   against the same `Config`, polls `sys.dm_tran_locks` and
//!   `sys.dm_os_waiting_tasks` for the captured `@@SPID`.
//!
//! The samplers run on a Tokio task and can be stopped with
//! [`SamplerHandle::stop`], which awaits the final sample, drops the
//! sidecar connection, and returns the aggregated summary.
//!
//! All sampling failures are non-fatal: the user query is unaffected
//! and a [`LockSummary::unavailable`] with the reason string is
//! returned so the UI can render a disabled-with-explanation state
//! rather than tearing the user's run.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::Row;
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::types::{
    BlockerInfo, ConnectionConfig, LockGranularity, LockSample, LockSummary, ObjectLockRow,
};

/// Default polling cadence when the caller doesn't specify one. 25 ms
/// is short enough to catch most user-visible row/table locks on a
/// modern Postgres / MSSQL without flooding the server. Bump it if
/// the query you care about runs for many seconds.
pub const DEFAULT_SAMPLE_INTERVAL_MS: u64 = 25;

/// Hard cap on the raw [`LockSample`] vector returned to the UI. The
/// timeline sparkline is fine with a downsampled view; we keep the
/// summary itself authoritative and just trim the raw stream so a
/// 60-second query doesn't ship 2400 samples per statement to the
/// front-end.
const MAX_SAMPLES_RETURNED: usize = 600;

/// Handle returned by `start`. Calling [`Self::stop`] stops the
/// background poller, awaits the final sample, and returns the
/// aggregated summary. Dropping the handle without `stop` is allowed
/// — the task fires-and-forgets and the sidecar connection is
/// closed when the task scope ends.
pub struct SamplerHandle {
    stop_tx: watch::Sender<bool>,
    join: JoinHandle<LockSummary>,
}

impl SamplerHandle {
    pub async fn stop(self) -> LockSummary {
        // Best-effort shutdown signal. If the receiver half has
        // dropped (task already exited), we still await the join
        // and propagate whatever it built.
        let _ = self.stop_tx.send(true);
        match self.join.await {
            Ok(summary) => summary,
            Err(e) => LockSummary::unavailable(0, format!("sampler join failed: {e}")),
        }
    }
}

// ── Postgres ────────────────────────────────────────────────────────

pub struct PgLockSampler;

impl PgLockSampler {
    /// Spawn a Postgres lock observer. `pid` is the backend PID of
    /// the **target session** — the connection that's about to run
    /// the user statement — captured by the caller via
    /// `SELECT pg_backend_pid()`.
    pub fn start(opts: PgConnectOptions, pid: i32, interval_ms: u64) -> SamplerHandle {
        let (stop_tx, stop_rx) = watch::channel(false);
        let interval = Duration::from_millis(interval_ms.max(1));

        let join = tokio::spawn(async move {
            // Sidecar pool: size 1, separate from the user pool so
            // we never starve user-visible work. Short connect
            // timeout — if the server is unreachable for the
            // observer there's nothing to do.
            let pool_res = PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(5))
                .connect_with(opts)
                .await;

            let pool = match pool_res {
                Ok(p) => p,
                Err(e) => {
                    return LockSummary::unavailable(
                        interval_ms,
                        format!("observer connect failed: {e}"),
                    );
                }
            };

            let mut agg = Aggregator::new(interval_ms);
            let started = Instant::now();
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // Burn the immediate first tick so the very first poll
            // happens at `interval`, not at `t=0`.
            ticker.tick().await;

            loop {
                let stop_changed = {
                    let mut rx = stop_rx.clone();
                    async move {
                        let _ = rx.changed().await;
                    }
                };
                tokio::select! {
                    biased;
                    _ = stop_changed => break,
                    _ = ticker.tick() => {
                        let at_ms = started.elapsed().as_millis() as u64;
                        if let Err(e) = poll_postgres(&pool, pid, at_ms, &mut agg).await {
                            // Don't kill the sampler on a single
                            // failed poll — record the most recent
                            // reason so the UI can surface it; the
                            // summary still ships.
                            agg.note_error(format!("poll: {e}"));
                        }
                    }
                }
            }

            // One last sample so a query that finished between
            // ticks at least gets one observation right at the end.
            let at_ms = started.elapsed().as_millis() as u64;
            let _ = poll_postgres(&pool, pid, at_ms, &mut agg).await;
            drop(pool); // sqlx pool drops cleanly on its own.
            agg.finish()
        });

        SamplerHandle { stop_tx, join }
    }
}

async fn poll_postgres(
    pool: &PgPool,
    pid: i32,
    at_ms: u64,
    agg: &mut Aggregator,
) -> Result<(), sqlx::Error> {
    // pg_blocking_pids() returns an int4[] of PIDs blocking ours.
    // We pull the first element (most-relevant blocker) to keep the
    // UI simple; users chasing complex blocking chains can drill
    // into pg_locks themselves.
    let rows = sqlx::query(
        "SELECT \
            l.locktype::text AS locktype, \
            l.mode::text AS mode, \
            l.granted AS granted, \
            n.nspname::text AS nspname, \
            c.relname::text AS relname, \
            (SELECT bp FROM unnest(pg_blocking_pids($1)) AS bp LIMIT 1) AS blocker_pid, \
            a.wait_event_type::text AS wait_event_type, \
            a.wait_event::text AS wait_event \
         FROM pg_locks l \
         LEFT JOIN pg_class c    ON c.oid = l.relation \
         LEFT JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_stat_activity a ON a.pid = l.pid \
         WHERE l.pid = $1",
    )
    .bind(pid)
    .fetch_all(pool)
    .await?;

    agg.begin_sample(at_ms);
    for row in &rows {
        let locktype: String = row.try_get("locktype").unwrap_or_default();
        let mode: String = row.try_get("mode").unwrap_or_default();
        let granted: bool = row.try_get("granted").unwrap_or(false);
        let nspname: Option<String> = row.try_get("nspname").ok();
        let relname: Option<String> = row.try_get("relname").ok();
        let blocker_pid: Option<i32> = row.try_get("blocker_pid").ok();
        let wait_event_type: Option<String> = row.try_get("wait_event_type").ok();
        let wait_event: Option<String> = row.try_get("wait_event").ok();

        let granularity = pg_granularity(&locktype);
        let object = match (nspname, relname) {
            (Some(n), Some(r)) => Some(format!("{n}.{r}")),
            (None, Some(r)) => Some(r),
            _ => None,
        };
        let reason = match (wait_event_type, wait_event) {
            (Some(t), Some(e)) => Some(format!("{t}/{e}")),
            (Some(t), None) => Some(t),
            (None, Some(e)) => Some(e),
            _ => None,
        };

        agg.add_sample(LockSample {
            at_ms,
            granularity,
            raw_kind: locktype,
            mode,
            granted,
            object,
            blocker_pid: blocker_pid.map(|p| p as i64),
        });
        if !granted {
            if let Some(bp) = blocker_pid {
                agg.note_blocker(bp as i64, reason);
            }
        }
    }
    agg.end_sample();
    Ok(())
}

/// Map Postgres `pg_locks.locktype` to our engine-agnostic
/// granularity vocabulary. The strings come from the Postgres
/// docs (LockTagType in `src/include/storage/lock.h`).
fn pg_granularity(locktype: &str) -> LockGranularity {
    match locktype {
        "relation" | "object" => LockGranularity::Table,
        "tuple" => LockGranularity::Row,
        "page" => LockGranularity::Page,
        "transactionid" | "virtualxid" => LockGranularity::Transaction,
        "advisory" | "userlock" => LockGranularity::Advisory,
        "extend" | "frozenid" | "spectoken" => LockGranularity::Metadata,
        _ => LockGranularity::Other,
    }
}

// ── MSSQL ───────────────────────────────────────────────────────────

pub struct MsSqlLockSampler;

impl MsSqlLockSampler {
    /// Spawn an MSSQL lock observer. `spid` is the captured
    /// `@@SPID` of the user session. `cfg` is the original
    /// connection configuration — we re-derive a tiberius
    /// `Config` from it so the sampler doesn't share the user
    /// session.
    pub fn start(cfg: ConnectionConfig, spid: i32, interval_ms: u64) -> SamplerHandle {
        let (stop_tx, stop_rx) = watch::channel(false);
        let interval = Duration::from_millis(interval_ms.max(1));

        let join = tokio::spawn(async move {
            // Build a fresh tiberius Config from the original
            // ConnectionConfig — `tiberius::Config` isn't Clone,
            // and even if it were, the user client is wrapped in a
            // mutex; sharing it would serialize the sampler behind
            // the user query.
            let mut tib_cfg = Config::new();
            tib_cfg.host(&cfg.host);
            tib_cfg.port(cfg.port);
            if !cfg.database.is_empty() {
                tib_cfg.database(&cfg.database);
            }
            tib_cfg.authentication(AuthMethod::sql_server(&cfg.username, &cfg.password));
            if cfg.trust_server_certificate {
                tib_cfg.trust_cert();
            }
            tib_cfg.encryption(EncryptionLevel::Required);

            let tcp = match TcpStream::connect(tib_cfg.get_addr()).await {
                Ok(t) => {
                    t.set_nodelay(true).ok();
                    t
                }
                Err(e) => {
                    return LockSummary::unavailable(
                        interval_ms,
                        format!("observer tcp failed: {e}"),
                    );
                }
            };
            let mut client: Client<Compat<TcpStream>> =
                match Client::connect(tib_cfg, tcp.compat_write()).await {
                    Ok(c) => c,
                    Err(e) => {
                        return LockSummary::unavailable(
                            interval_ms,
                            format!("observer connect failed: {e}"),
                        );
                    }
                };

            let mut agg = Aggregator::new(interval_ms);
            let started = Instant::now();
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticker.tick().await;

            loop {
                let stop_changed = {
                    let mut rx = stop_rx.clone();
                    async move {
                        let _ = rx.changed().await;
                    }
                };
                tokio::select! {
                    biased;
                    _ = stop_changed => break,
                    _ = ticker.tick() => {
                        let at_ms = started.elapsed().as_millis() as u64;
                        if let Err(e) = poll_mssql(&mut client, spid, at_ms, &mut agg).await {
                            agg.note_error(format!("poll: {e}"));
                        }
                    }
                }
            }
            let at_ms = started.elapsed().as_millis() as u64;
            let _ = poll_mssql(&mut client, spid, at_ms, &mut agg).await;
            agg.finish()
        });

        SamplerHandle { stop_tx, join }
    }
}

async fn poll_mssql(
    client: &mut Client<Compat<TcpStream>>,
    spid: i32,
    at_ms: u64,
    agg: &mut Aggregator,
) -> Result<(), tiberius::error::Error> {
    use futures::TryStreamExt;

    // sys.dm_tran_locks gives one row per held/waiting lock.
    // We left-join sys.partitions so we can resolve `OBJECT_NAME`
    // for KEY/PAGE/RID locks (which only carry an HOBT id).
    let q = format!(
        "SELECT \
            l.resource_type AS resource_type, \
            l.request_mode AS request_mode, \
            l.request_status AS request_status, \
            CASE \
              WHEN l.resource_type IN ('KEY','RID','PAGE','HOBT') THEN \
                ISNULL(QUOTENAME(OBJECT_SCHEMA_NAME(p.object_id)) + '.' + QUOTENAME(OBJECT_NAME(p.object_id)), '') \
              WHEN l.resource_type = 'OBJECT' THEN \
                ISNULL(QUOTENAME(OBJECT_SCHEMA_NAME(l.resource_associated_entity_id)) + '.' + QUOTENAME(OBJECT_NAME(l.resource_associated_entity_id)), '') \
              ELSE '' \
            END AS obj_name \
         FROM sys.dm_tran_locks l \
         LEFT JOIN sys.partitions p ON p.hobt_id = l.resource_associated_entity_id \
          AND l.resource_type IN ('KEY','PAGE','RID','HOBT') \
         WHERE l.request_session_id = {spid}"
    );

    let mut blocker: Option<(i64, Option<String>)> = None;
    {
        let waits_q = format!(
            "SELECT TOP 1 blocking_session_id, wait_type \
             FROM sys.dm_os_waiting_tasks WHERE session_id = {spid}"
        );
        let mut stream = client.simple_query(waits_q).await?;
        while let Some(item) = stream.try_next().await? {
            if let QueryItem::Row(row) = item {
                let bsid: Option<i32> = row.try_get::<i16, _>(0).ok().flatten().map(|v| v as i32);
                let wait_type: Option<String> = row
                    .try_get::<&str, _>(1)
                    .ok()
                    .flatten()
                    .map(|s| s.to_string());
                if let Some(b) = bsid {
                    blocker = Some((b as i64, wait_type));
                }
            }
        }
    }

    // Now the locks themselves.
    {
        let mut stream = client.simple_query(q).await?;
        agg.begin_sample(at_ms);
        while let Some(item) = stream.try_next().await? {
            if let QueryItem::Row(row) = item {
                let resource_type: String = row
                    .try_get::<&str, _>("resource_type")
                    .ok()
                    .flatten()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let mode: String = row
                    .try_get::<&str, _>("request_mode")
                    .ok()
                    .flatten()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let status: String = row
                    .try_get::<&str, _>("request_status")
                    .ok()
                    .flatten()
                    .unwrap_or("GRANT")
                    .trim()
                    .to_string();
                let obj: Option<String> = row
                    .try_get::<&str, _>("obj_name")
                    .ok()
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let granted = status.eq_ignore_ascii_case("GRANT");
                let granularity = mssql_granularity(&resource_type);
                agg.add_sample(LockSample {
                    at_ms,
                    granularity,
                    raw_kind: resource_type,
                    mode,
                    granted,
                    object: obj,
                    blocker_pid: blocker.as_ref().map(|(p, _)| *p),
                });
                if !granted {
                    if let Some((p, reason)) = blocker.as_ref() {
                        agg.note_blocker(*p, reason.clone());
                    }
                }
            }
        }
        agg.end_sample();
    }

    Ok(())
}

fn mssql_granularity(resource_type: &str) -> LockGranularity {
    match resource_type {
        "KEY" | "RID" => LockGranularity::Row,
        "PAGE" => LockGranularity::Page,
        "OBJECT" => LockGranularity::Table,
        "DATABASE" => LockGranularity::Database,
        "XACT" | "APPLICATION" => LockGranularity::Transaction,
        "METADATA" | "SCHEMA" | "HOBT" | "ALLOCATION_UNIT" | "EXTENT" | "FILE" => {
            LockGranularity::Metadata
        }
        _ => LockGranularity::Other,
    }
}

// ── Aggregator ──────────────────────────────────────────────────────

/// Accumulates the per-sample lock observations into the rollups
/// the UI consumes. Cheap clone (Vec / HashMap) so the PG poller
/// can briefly snapshot it inside an `Arc<Mutex>` if needed.
#[derive(Clone)]
struct Aggregator {
    interval_ms: u64,
    samples: Vec<LockSample>,
    sample_count: u32,
    blocked_samples: u32,
    /// Tracks whether any lock in the current sample window was
    /// not granted, so we count one "blocked tick" per sampling
    /// interval rather than one per row.
    cur_sample_blocked: bool,
    cur_sample_started: bool,
    /// Per-sample tally of (granularity → count). Replaced each
    /// sample; we max-merge into `peak_by_granularity`.
    cur_by_granularity: HashMap<LockGranularity, u32>,
    cur_by_mode: HashMap<String, u32>,
    cur_by_object: HashMap<String, ObjectAccum>,
    peak_by_granularity: HashMap<LockGranularity, u32>,
    peak_by_mode: HashMap<String, u32>,
    objects: HashMap<String, ObjectAccum>,
    blockers: HashMap<i64, BlockerAccum>,
    last_error: Option<String>,
}

#[derive(Clone, Default)]
struct ObjectAccum {
    granularities: HashSet<LockGranularity>,
    modes: HashSet<String>,
    peak_locks: u32,
    waited: bool,
}

#[derive(Clone, Default)]
struct BlockerAccum {
    reason: Option<String>,
    wait_samples: u32,
}

impl Aggregator {
    fn new(interval_ms: u64) -> Self {
        Self {
            interval_ms,
            samples: Vec::new(),
            sample_count: 0,
            blocked_samples: 0,
            cur_sample_blocked: false,
            cur_sample_started: false,
            cur_by_granularity: HashMap::new(),
            cur_by_mode: HashMap::new(),
            cur_by_object: HashMap::new(),
            peak_by_granularity: HashMap::new(),
            peak_by_mode: HashMap::new(),
            objects: HashMap::new(),
            blockers: HashMap::new(),
            last_error: None,
        }
    }

    fn begin_sample(&mut self, _at_ms: u64) {
        self.cur_by_granularity.clear();
        self.cur_by_mode.clear();
        self.cur_by_object.clear();
        self.cur_sample_blocked = false;
        self.cur_sample_started = true;
    }

    fn add_sample(&mut self, sample: LockSample) {
        // Hard cap — once we hit the ceiling we drop additional
        // raw samples but keep updating the rollups, so the
        // summary's `peak_*` numbers stay correct even when the
        // timeline view loses fidelity on very long queries.
        if self.samples.len() < MAX_SAMPLES_RETURNED {
            self.samples.push(sample.clone());
        }

        *self.cur_by_granularity.entry(sample.granularity).or_insert(0) += 1;
        *self.cur_by_mode.entry(sample.mode.clone()).or_insert(0) += 1;
        if !sample.granted {
            self.cur_sample_blocked = true;
        }
        if let Some(obj) = sample.object.as_ref() {
            let entry = self.cur_by_object.entry(obj.clone()).or_default();
            entry.granularities.insert(sample.granularity);
            if !sample.mode.is_empty() {
                entry.modes.insert(sample.mode.clone());
            }
            entry.peak_locks += 1;
            if !sample.granted {
                entry.waited = true;
            }
        }
    }

    fn end_sample(&mut self) {
        if !self.cur_sample_started {
            return;
        }
        self.sample_count = self.sample_count.saturating_add(1);
        if self.cur_sample_blocked {
            self.blocked_samples = self.blocked_samples.saturating_add(1);
        }
        // Max-merge per-sample tallies into the peak rollups.
        for (k, v) in self.cur_by_granularity.drain() {
            let slot = self.peak_by_granularity.entry(k).or_insert(0);
            if v > *slot {
                *slot = v;
            }
        }
        for (k, v) in self.cur_by_mode.drain() {
            let slot = self.peak_by_mode.entry(k).or_insert(0);
            if v > *slot {
                *slot = v;
            }
        }
        for (obj, cur) in self.cur_by_object.drain() {
            let entry = self.objects.entry(obj).or_default();
            entry.granularities.extend(cur.granularities);
            entry.modes.extend(cur.modes);
            if cur.peak_locks > entry.peak_locks {
                entry.peak_locks = cur.peak_locks;
            }
            if cur.waited {
                entry.waited = true;
            }
        }
        self.cur_sample_started = false;
    }

    fn note_blocker(&mut self, pid: i64, reason: Option<String>) {
        let entry = self.blockers.entry(pid).or_default();
        if entry.reason.is_none() && reason.is_some() {
            entry.reason = reason;
        }
        entry.wait_samples = entry.wait_samples.saturating_add(1);
    }

    fn note_error(&mut self, msg: String) {
        self.last_error = Some(msg);
    }

    fn finish(self) -> LockSummary {
        let mut objects: Vec<ObjectLockRow> = self
            .objects
            .into_iter()
            .map(|(object, acc)| {
                let mut granularities: Vec<LockGranularity> = acc.granularities.into_iter().collect();
                granularities.sort_by_key(|g| g.as_str());
                let mut modes: Vec<String> = acc.modes.into_iter().collect();
                modes.sort();
                ObjectLockRow {
                    object,
                    granularities,
                    modes,
                    peak_locks: acc.peak_locks,
                    waited: acc.waited,
                }
            })
            .collect();
        objects.sort_by(|a, b| b.peak_locks.cmp(&a.peak_locks).then(a.object.cmp(&b.object)));

        let blockers: Vec<BlockerInfo> = self
            .blockers
            .into_iter()
            .map(|(pid, acc)| BlockerInfo {
                pid,
                reason: acc.reason,
                wait_ms: acc.wait_samples as u64 * self.interval_ms,
            })
            .collect();

        let blocked_ms = self.blocked_samples as u64 * self.interval_ms;

        LockSummary {
            sample_interval_ms: self.interval_ms,
            sample_count: self.sample_count,
            blocked_ms,
            peak_by_granularity: self.peak_by_granularity,
            peak_by_mode: self.peak_by_mode,
            objects,
            blockers,
            samples: self.samples,
            error: self.last_error,
        }
    }
}
