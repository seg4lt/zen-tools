//! Parsers for `.http` / `.rest` files, env JSON, and perf YAML configs.
//!
//! All parsing in this crate is synchronous and runtime-free. Callers can
//! use any async runtime to read files from disk and pass the contents in.

#![warn(missing_docs)]

pub mod env_file;
pub mod error;
pub mod http_file;
pub mod perf_config;
pub mod variables;

pub use env_file::{find_env_file, parse_env_file};
pub use error::ParserError;
pub use http_file::parse_http_file;
pub use perf_config::{parse_request_ref, PerfConfig, PerfTest, TestType};
pub use variables::{
    load_perf_variables, load_perf_variables_hierarchy, substitute_perf_variables, PerfVariables,
};
