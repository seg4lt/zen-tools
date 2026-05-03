//! Pure data model for the zen-tools workspace.
//!
//! This crate has no I/O, no async, and no network dependencies. It defines
//! the request/response/environment types that every other crate consumes,
//! and is therefore the most stable layer of the stack.

#![warn(missing_docs)]

pub mod environment;
pub mod ids;
pub mod prelude;
pub mod request;
pub mod response;

/// Hash map specialised on the `ahash` hasher for hot-path lookups.
pub type FxHashMap<K, V> = ahash::HashMap<K, V>;
/// Hash set specialised on the `ahash` hasher for hot-path membership tests.
pub type FxHashSet<T> = ahash::HashSet<T>;
