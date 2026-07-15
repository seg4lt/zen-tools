//! Native filesystem watches for the file-tree based tools.
//!
//! The frontend renders snapshots returned by the existing discovery
//! commands. This module owns recursive OS watchers for those roots and emits
//! one debounced, tool-scoped event when a snapshot may have changed.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use notify::event::ModifyKind;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Event emitted after native filesystem changes have settled briefly.
pub const FILE_TREE_CHANGED_EVENT: &str = "file-tree:changed";

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(75);

/// Identifies which explorer owns a watched root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchScope {
    /// HTTP runner project tree.
    Http,
    /// Database explorer SQL workspace tree.
    Sql,
    /// Markdown vault tree.
    Markdown,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeChanged {
    scope: WatchScope,
}

/// Owns the native watchers for every file-tree root.
///
/// Watchers are keyed by `(scope, root)`, which allows the same directory to
/// be open in multiple tools without coupling their project lists.
pub struct FileTreeWatcher {
    watchers: parking_lot::Mutex<HashMap<(WatchScope, PathBuf), RecommendedWatcher>>,
    changed_tx: Sender<WatchScope>,
}

impl FileTreeWatcher {
    /// Create the registry and its background event-coalescing worker.
    pub fn new(app: AppHandle) -> Self {
        let (changed_tx, changed_rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("file-tree-watcher-dispatch".into())
            .spawn(move || dispatch_changes(app, changed_rx))
            .expect("spawn file-tree watcher dispatch thread");

        Self {
            watchers: parking_lot::Mutex::new(HashMap::new()),
            changed_tx,
        }
    }

    /// Make the watched roots for `scope` exactly match `roots`.
    ///
    /// Missing roots are skipped. Existing registrations are retained so a
    /// discovery refresh does not churn OS watcher handles.
    pub fn sync_roots(&self, scope: WatchScope, roots: impl IntoIterator<Item = PathBuf>) {
        let desired: HashSet<PathBuf> = roots
            .into_iter()
            .filter(|root| root.is_dir())
            .map(|root| dunce::canonicalize(&root).unwrap_or(root))
            .collect();

        let mut watchers = self.watchers.lock();
        watchers.retain(|(registered_scope, root), _| {
            *registered_scope != scope || desired.contains(root)
        });

        for root in desired {
            let key = (scope, root.clone());
            if watchers.contains_key(&key) {
                continue;
            }

            let changed_tx = self.changed_tx.clone();
            let result = RecommendedWatcher::new(
                move |event: notify::Result<Event>| match event {
                    Ok(event) if is_tree_change(&event) => {
                        let _ = changed_tx.send(scope);
                    }
                    Ok(_) => {}
                    Err(error) => {
                        // A watcher error can mean events were lost. Trigger a
                        // full discovery so the tree converges again.
                        tracing::warn!(
                            ?error,
                            ?scope,
                            "file-tree watcher error; requesting rescan"
                        );
                        let _ = changed_tx.send(scope);
                    }
                },
                Config::default(),
            )
            .and_then(|mut watcher| {
                watcher.watch(&root, RecursiveMode::Recursive)?;
                Ok(watcher)
            });

            match result {
                Ok(watcher) => {
                    watchers.insert(key, watcher);
                }
                Err(error) => {
                    tracing::warn!(?error, ?scope, path = %root.display(), "failed to watch file-tree root");
                }
            }
        }
    }
}

fn is_tree_change(event: &Event) -> bool {
    if event.need_rescan() {
        return true;
    }

    match event.kind {
        EventKind::Create(_) | EventKind::Remove(_) => true,
        EventKind::Modify(ModifyKind::Name(_) | ModifyKind::Any | ModifyKind::Other) => true,
        EventKind::Any | EventKind::Other => true,
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => {
            false
        }
    }
}

fn dispatch_changes(app: AppHandle, changed_rx: Receiver<WatchScope>) {
    while let Ok(first) = changed_rx.recv() {
        let mut scopes = HashSet::from([first]);
        let deadline = Instant::now() + DEBOUNCE_WINDOW;

        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            match changed_rx.recv_timeout(remaining) {
                Ok(scope) => {
                    scopes.insert(scope);
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        for scope in scopes {
            if let Err(error) = app.emit(FILE_TREE_CHANGED_EVENT, FileTreeChanged { scope }) {
                tracing::warn!(?error, ?scope, "failed to emit file-tree change");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, DataChange};

    #[test]
    fn ignores_access_events_but_keeps_structural_changes() {
        let access = Event::new(EventKind::Access(AccessKind::Any));
        let create = Event::new(EventKind::Create(CreateKind::File));
        let content = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)));
        let unknown_data = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)));

        assert!(!is_tree_change(&access));
        assert!(is_tree_change(&create));
        assert!(!is_tree_change(&content));
        assert!(!is_tree_change(&unknown_data));
    }
}
