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

    /// Load an additional config file. Same key-value format as the
    /// default user config (`window-padding-balance = true`, etc.).
    /// Calling this AFTER `load_default_files` lets overrides win
    /// (ghostty's parser applies values left-to-right and the last
    /// write wins for any given key).
    ///
    /// Errors if the path contains an interior NUL byte. Missing /
    /// unreadable files are NOT an error here — ghostty silently
    /// ignores them; that matches the upstream Swift wrapper's
    /// behaviour (`Ghostty.App+Config.swift:loadFile`).
    pub fn load_file(&mut self, path: &std::path::Path) -> Result<()> {
        let path_str = path
            .to_str()
            .ok_or(Error::ConfigCreateFailed)?;
        let cstring = std::ffi::CString::new(path_str)
            .map_err(|_| Error::ConfigCreateFailed)?;
        unsafe {
            ghostty_sys::ghostty_config_load_file(self.inner, cstring.as_ptr())
        };
        Ok(())
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

    /// Borrow the raw pointer for read-only FFI calls (e.g.
    /// `ghostty_app_update_config` which takes `*const Config` —
    /// caller retains ownership). Drop still frees ours when the
    /// `Config` goes out of scope.
    pub fn raw(&self) -> ghostty_config_t {
        self.inner
    }
}

impl Drop for Config {
    fn drop(&mut self) {
        if !self.inner.is_null() {
            unsafe { ghostty_sys::ghostty_config_free(self.inner) };
        }
    }
}
