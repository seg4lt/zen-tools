use thiserror::Error;

#[derive(Debug, Error, Clone)]
pub enum Error {
    #[error("ghostty_init failed (rc={0})")]
    InitFailed(i32),
    #[error("ghostty_app_new returned null")]
    AppCreateFailed,
    #[error("ghostty_config_new returned null")]
    ConfigCreateFailed,
    #[error("ghostty_surface_new returned null")]
    SurfaceCreateFailed,
    #[error("invalid argument: {0}")]
    InvalidArgument(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;
