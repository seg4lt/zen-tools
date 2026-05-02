//! Notification-state diffing — port of
//! `Sources/PRMaster/Services/CacheService.swift`.
//!
//! Two on-disk JSON files live next to the filter SQLite under
//! `~/Library/Application Support/com.zen-tools.app/prmaster/`:
//!
//! * **`pr_cache.json`** — last refresh's enriched PR lists, used to
//!   warm the popover instantly on launch.
//! * **`notification_state.json`** — per-PR "what we last told the user
//!   about" record. Diffing the latest refresh against this file is what
//!   converts a poll into zero-or-more user-visible notifications.
//!
//! The state machine here is a faithful 1-to-1 port of the Swift logic
//! in `CacheService.checkAndUpdateNotificationState` and
//! `checkMyPRNotificationState`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use zen_github::{EnrichedPullRequest, ReviewState};

/// Why a notification fires for a PR you're reviewing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewNotificationReason {
    /// First time we've seen this PR — fire "New PR to Review".
    NewPr,
    /// Existing PR's `updatedAt` advanced — fire "PR Updated".
    NewCommits,
}

/// Why a notification fires for a PR you authored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "by")]
pub enum MyPrNotificationReason {
    /// Someone landed a new review (login).
    NewReview(String),
    /// New comment count > previous.
    NewComment,
}

/// Per-PR snapshot used to diff successive polls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrNotificationState {
    /// `"{owner}/{repo}#{number}"`.
    pub key: String,
    /// PR's last-known `updatedAt` timestamp.
    pub last_updated_at: DateTime<Utc>,
    /// `true` once the user has been notified about the existence of this PR.
    #[serde(default)]
    pub notified_for_new: bool,
    /// Wall-clock when we last touched this entry.
    pub last_seen: DateTime<Utc>,
    /// Active (non-dismissed) review count — for My-PR diffs.
    #[serde(default)]
    pub active_review_count: Option<u64>,
    /// Logins of every reviewer that has submitted (any non-dismissed
    /// state). Stored as `Vec<String>` for stable JSON; treated as a set
    /// at compare time.
    #[serde(default)]
    pub review_authors: Option<Vec<String>>,
    /// Total comment count last seen.
    #[serde(default)]
    pub comment_count: Option<u64>,
}

/// File-backed notification-state cache.
#[derive(Clone)]
pub struct NotificationStore {
    path: PathBuf,
    inner: Arc<Mutex<HashMap<String, PrNotificationState>>>,
}

impl std::fmt::Debug for NotificationStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotificationStore")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl NotificationStore {
    /// Open the store at `dir/notification_state.json`. Missing or
    /// corrupted files are treated as empty (matching Swift behaviour).
    pub fn open_in(dir: &std::path::Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("notification_state.json");
        let map = if let Ok(bytes) = std::fs::read(&path) {
            serde_json::from_slice::<HashMap<String, PrNotificationState>>(&bytes)
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Self {
            path,
            inner: Arc::new(Mutex::new(map)),
        })
    }

    fn save(&self, map: &HashMap<String, PrNotificationState>) {
        if let Ok(bytes) = serde_json::to_vec(map) {
            // Atomic write: rename a temp file. Best-effort — failures
            // simply mean we'll redo the diff on next poll.
            let tmp = self.path.with_extension("tmp");
            if std::fs::write(&tmp, &bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    /// Mirror of Swift `checkAndUpdateNotificationState`.
    pub fn check_review_notification(
        &self,
        pr: &EnrichedPullRequest,
    ) -> Option<ReviewNotificationReason> {
        let key = pr.id();
        let mut map = self.inner.lock();
        let now = Utc::now();
        let updated = pr.pr.updated_at;

        let (reason, prior) = match map.get(&key).cloned() {
            Some(existing) if updated > existing.last_updated_at => {
                (Some(ReviewNotificationReason::NewCommits), Some(existing))
            }
            Some(existing) => (None, Some(existing)),
            None => (Some(ReviewNotificationReason::NewPr), None),
        };

        if reason.is_some() || prior.is_none() {
            map.insert(
                key.clone(),
                PrNotificationState {
                    key: key.clone(),
                    last_updated_at: updated,
                    notified_for_new: true,
                    last_seen: now,
                    active_review_count: prior.as_ref().and_then(|s| s.active_review_count),
                    review_authors: prior.as_ref().and_then(|s| s.review_authors.clone()),
                    comment_count: prior.as_ref().and_then(|s| s.comment_count),
                },
            );
            self.save(&map);
        }
        reason
    }

    /// Insert a "seen" record without firing — used when an existing PR
    /// in the cache hasn't changed (mirrors Swift's `markAsSeen`).
    pub fn mark_seen(&self, pr: &EnrichedPullRequest) {
        let key = pr.id();
        let mut map = self.inner.lock();
        if !map.contains_key(&key) {
            let now = Utc::now();
            map.insert(
                key.clone(),
                PrNotificationState {
                    key,
                    last_updated_at: pr.pr.updated_at,
                    notified_for_new: true,
                    last_seen: now,
                    active_review_count: None,
                    review_authors: None,
                    comment_count: None,
                },
            );
            self.save(&map);
        }
    }

    /// Mirror of Swift `checkMyPRNotificationState`.
    pub fn check_my_pr_notification(
        &self,
        pr: &EnrichedPullRequest,
    ) -> Option<MyPrNotificationReason> {
        let key = pr.id();
        let mut map = self.inner.lock();

        let active_reviews: Vec<&zen_github::Review> = pr
            .reviews
            .iter()
            .filter(|r| r.state != ReviewState::Dismissed)
            .collect();
        let current_count = active_reviews.len() as u64;
        let current_reviewers: std::collections::HashSet<String> = active_reviews
            .iter()
            .filter_map(|r| r.author.as_ref().map(|a| a.login.clone()))
            .collect();
        let current_comments = pr
            .detail
            .as_ref()
            .and_then(|d| d.comments.as_ref())
            .map(|c| c.total_count)
            .unwrap_or(0);

        let now = Utc::now();
        let make_state = |key: String, reviewers: Vec<String>, updated_at: DateTime<Utc>| {
            PrNotificationState {
                key,
                last_updated_at: updated_at,
                notified_for_new: true,
                last_seen: now,
                active_review_count: Some(current_count),
                review_authors: Some(reviewers),
                comment_count: Some(current_comments),
            }
        };

        let existing = match map.get(&key).cloned() {
            Some(s) if s.review_authors.is_some() => s,
            _ => {
                let reviewers: Vec<String> = current_reviewers.into_iter().collect();
                map.insert(
                    key.clone(),
                    make_state(key, reviewers, pr.pr.updated_at),
                );
                self.save(&map);
                return None;
            }
        };

        // Review dismissal (user pushed commits) — count went down.
        if let Some(prev_count) = existing.active_review_count {
            if current_count < prev_count {
                let reviewers: Vec<String> = current_reviewers.into_iter().collect();
                map.insert(
                    key.clone(),
                    make_state(key, reviewers, pr.pr.updated_at),
                );
                self.save(&map);
                return None;
            }
        }

        // New reviewer landed.
        if let Some(prev) = existing.review_authors.as_ref() {
            let prev_set: std::collections::HashSet<&String> = prev.iter().collect();
            let new_reviewers: Vec<String> = current_reviewers
                .iter()
                .filter(|r| !prev_set.contains(*r))
                .cloned()
                .collect();
            if let Some(reviewer) = new_reviewers.into_iter().next() {
                let reviewers: Vec<String> = current_reviewers.into_iter().collect();
                map.insert(
                    key.clone(),
                    make_state(key, reviewers, pr.pr.updated_at),
                );
                self.save(&map);
                return Some(MyPrNotificationReason::NewReview(reviewer));
            }
        }

        // New comments.
        if let Some(prev_comments) = existing.comment_count {
            if current_comments > prev_comments {
                let reviewers: Vec<String> = current_reviewers.into_iter().collect();
                map.insert(
                    key.clone(),
                    make_state(key, reviewers, pr.pr.updated_at),
                );
                self.save(&map);
                return Some(MyPrNotificationReason::NewComment);
            }
        }

        // State drifted but nothing notification-worthy — silently update.
        if existing.active_review_count != Some(current_count)
            || existing.comment_count != Some(current_comments)
        {
            let reviewers: Vec<String> = current_reviewers.into_iter().collect();
            map.insert(
                key.clone(),
                make_state(key, reviewers, pr.pr.updated_at),
            );
            self.save(&map);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use tempfile::tempdir;
    use zen_github::{
        Author, CommentInfo, PrDetail, PullRequest, Repository, Review, ReviewAuthor,
    };

    fn make_pr(id: u64, updated: DateTime<Utc>) -> PullRequest {
        PullRequest {
            number: id,
            title: format!("PR {id}"),
            url: "u".into(),
            state: "OPEN".into(),
            created_at: updated,
            updated_at: updated,
            is_draft: false,
            author: Some(Author {
                login: "me".into(),
                ..Default::default()
            }),
            repository: Repository {
                name: "repo".into(),
                name_with_owner: "octo/repo".into(),
            },
        }
    }

    fn enriched(
        pr: PullRequest,
        reviews: Vec<Review>,
        comments: u64,
    ) -> EnrichedPullRequest {
        EnrichedPullRequest {
            pr,
            review_decision: None,
            reviews,
            requested_reviewers: vec![],
            merged_by: None,
            merged_at: None,
            detail: Some(PrDetail {
                comments: Some(CommentInfo {
                    total_count: comments,
                }),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn first_sighting_fires_new_pr() {
        let dir = tempdir().unwrap();
        let store = NotificationStore::open_in(dir.path()).unwrap();
        let pr = enriched(make_pr(1, Utc::now()), vec![], 0);
        assert_eq!(
            store.check_review_notification(&pr),
            Some(ReviewNotificationReason::NewPr)
        );
        // Second call: no change.
        assert_eq!(store.check_review_notification(&pr), None);
    }

    #[test]
    fn updated_at_advance_fires_new_commits() {
        let dir = tempdir().unwrap();
        let store = NotificationStore::open_in(dir.path()).unwrap();
        let now = Utc::now();
        let pr1 = enriched(make_pr(7, now), vec![], 0);
        let _ = store.check_review_notification(&pr1);
        let pr2 = enriched(make_pr(7, now + Duration::seconds(10)), vec![], 0);
        assert_eq!(
            store.check_review_notification(&pr2),
            Some(ReviewNotificationReason::NewCommits)
        );
    }

    #[test]
    fn my_pr_first_seen_does_not_fire() {
        let dir = tempdir().unwrap();
        let store = NotificationStore::open_in(dir.path()).unwrap();
        let pr = enriched(make_pr(11, Utc::now()), vec![], 0);
        assert_eq!(store.check_my_pr_notification(&pr), None);
    }

    #[test]
    fn my_pr_new_reviewer_fires() {
        let dir = tempdir().unwrap();
        let store = NotificationStore::open_in(dir.path()).unwrap();
        let now = Utc::now();
        let p1 = enriched(make_pr(20, now), vec![], 0);
        store.check_my_pr_notification(&p1); // initialise
        let p2 = enriched(
            make_pr(20, now),
            vec![Review {
                author: Some(ReviewAuthor {
                    login: "alice".into(),
                }),
                state: ReviewState::Approved,
            }],
            0,
        );
        assert_eq!(
            store.check_my_pr_notification(&p2),
            Some(MyPrNotificationReason::NewReview("alice".into()))
        );
    }

    #[test]
    fn my_pr_new_comment_fires() {
        let dir = tempdir().unwrap();
        let store = NotificationStore::open_in(dir.path()).unwrap();
        let now = Utc::now();
        let p1 = enriched(make_pr(30, now), vec![], 1);
        store.check_my_pr_notification(&p1);
        let p2 = enriched(make_pr(30, now), vec![], 4);
        assert_eq!(
            store.check_my_pr_notification(&p2),
            Some(MyPrNotificationReason::NewComment)
        );
    }
}
