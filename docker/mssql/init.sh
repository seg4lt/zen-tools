#!/usr/bin/env bash
# Sidecar init container entrypoint. Runs once the mssql service's TCP
# port is open and applies docker/mssql/01-init.sql via sqlcmd.
# Idempotent — safe to re-run.
set -euo pipefail

# Pick whichever sqlcmd is available — mssql-tools18 (newer images),
# mssql-tools (older), or PATH (if the image installs it elsewhere).
SQLCMD=""
for candidate in /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd "$(command -v sqlcmd 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    SQLCMD="$candidate"
    break
  fi
done

if [ -z "$SQLCMD" ]; then
  echo "init: no sqlcmd binary found in this image" >&2
  exit 1
fi

echo "init: using $SQLCMD"

# The compose healthcheck only verifies the TCP port is open; the SQL
# engine may still be finishing crash-recovery and reject logins for a
# few more seconds. Poll until SELECT 1 succeeds (max ~60s).
echo "init: waiting for mssql to accept logins…"
for attempt in $(seq 1 30); do
  if "$SQLCMD" -C -S mssql,1433 -U sa -P "$MSSQL_SA_PASSWORD" -l 5 -Q "SELECT 1" >/dev/null 2>&1; then
    echo "init: mssql is accepting logins (attempt $attempt)"
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "init: timed out waiting for mssql logins" >&2
    "$SQLCMD" -C -S mssql,1433 -U sa -P "$MSSQL_SA_PASSWORD" -l 5 -Q "SELECT 1" || true
    exit 1
  fi
  sleep 2
done

echo "init: applying /work/01-init.sql against mssql:1433…"

# -C trusts the self-signed cert that the dev image ships with.
# -I enables SET QUOTED_IDENTIFIER ON, which sqlcmd otherwise leaves OFF.
# Required for filtered indexes (CREATE INDEX … WHERE …), indexed views,
# computed-column indexes, etc. — the seed uses several. Without it the
# very first filtered index aborts the run and nothing past shop.customers
# gets created.
"$SQLCMD" -C -I -S mssql,1433 -U sa -P "$MSSQL_SA_PASSWORD" -b -i /work/01-init.sql

echo "init: done"
