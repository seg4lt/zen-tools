use crate::error::{Error, Result};
use ghostty_sys::ghostty_config_t;

/// Wraps `ghostty_config_t`. Created by `Config::new()`, optionally
/// loaded from default config files via `load_default_files()`, and
/// must be `finalize()`d before being passed to `App::new`.
///
/// Drop frees the config — but note that `App::new` consumes the config
/// by transferring ownership to ghostty (per the C API). Use the
/// `into_raw()` method when handing to App.
pub struct Config {
    inner: ghostty_config_t,
}

impl Config {
    pub fn new() -> Result<Self> {
        // Safety: ghostty_config_new takes no inputs and returns an opaque
        // handle. NULL means allocation failed.
        let inner = unsafe { ghostty_sys::ghostty_config_new() };
        if inner.is_null() {
            return Err(Error::ConfigCreateFailed);
        }
        Ok(Self { inner })
    }

    /// Load default config files (~/.config/ghostty/config etc).
    pub fn load_default_files(&mut self) {
        unsafe { ghostty_sys::ghostty_config_load_default_files(self.inner) };
    }

    /// Finalise the config — must be called before passing to `App::new`.
    pub fn finalize(&mut self) {
        unsafe { ghostty_sys::ghostty_config_finalize(self.inner) };
    }

    /// Hand off ownership to ghostty (consumed by `ghostty_app_new`).
    /// After calling this, do not use the `Config` further; we still have
    /// a Rust handle but ghostty owns the underlying pointer.
    pub(crate) fn into_raw(self) -> ghostty_config_t {
        let p = self.inner;
        // Don't run our Drop — ghostty owns it now.
        std::mem::forget(self);
        p
    }
}

impl Drop for Config {
    fn drop(&mut self) {
        if !self.inner.is_null() {
            unsafe { ghostty_sys::ghostty_config_free(self.inner) };
        }
    }
}
