//! Parsers for `.http` / `.rest` files, env JSON, and perf YAML configs.
//!
//! All parsing in this crate is synchronous and runtime-free. Callers can
//! use any async runtime to read files from disk and pass the contents in.
