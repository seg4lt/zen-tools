//! HTTP execution, variable substitution, and dependency resolution.
//!
//! Built on `reqwest` and `tokio`. The public surface is framework-agnostic:
//! the Tauri layer composes this crate without leaking Tauri types into it.

#![warn(missing_docs)]

pub mod dependency;
pub mod error;
pub mod executor;
pub mod registry;
pub mod variable;

pub use dependency::{
    has_cross_file_dependencies, resolve_execution_order, CrossFileDependencyResolver,
    DependencyResolver, QualifiedRequestId,
};
pub use error::{CrossFileDependencyError, DependencyError, FileRegistryError, HttpError};
pub use executor::{create_executor, HttpExecutor};
pub use registry::FileRegistry;
pub use variable::{
    extract_form_value, extract_header_value, extract_header_value_ahash, extract_json_value,
    parse_extraction_path, substitute_variables, ExtractionSource, VariableResolver,
};
