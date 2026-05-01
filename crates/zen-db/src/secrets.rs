//! OS-keychain backed password store.
//!
//! Service name is constant, account is the connection UUID. The `keyring`
//! crate handles platform routing (macOS Keychain, libsecret/SecretService
//! on Linux, Credential Manager on Windows).

use crate::driver::{DbError, DbResult};

const SERVICE: &str = "com.zen.tools.db";

fn entry(connection_id: &str) -> DbResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, connection_id).map_err(|e| DbError::Keyring(e.to_string()))
}

pub fn store_password(connection_id: &str, password: &str) -> DbResult<()> {
    entry(connection_id)?
        .set_password(password)
        .map_err(|e| DbError::Keyring(e.to_string()))
}

pub fn load_password(connection_id: &str) -> DbResult<Option<String>> {
    match entry(connection_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(DbError::Keyring(e.to_string())),
    }
}

pub fn delete_password(connection_id: &str) -> DbResult<()> {
    match entry(connection_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(DbError::Keyring(e.to_string())),
    }
}
