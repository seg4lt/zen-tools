//! Streaming model download with progress callback.
//!
//! Writes to `<models_dir>/ggml-<basename>.bin.tmp` and atomically
//! renames into place on successful completion. On any error the temp
//! file is left in place for the next attempt to overwrite — small
//! enough that a stale `.tmp` isn't worth deleting eagerly.
//!
//! No sha256 verification is performed for v1 (huggingface.co over
//! HTTPS is the trust anchor). The hashing infrastructure is staged via
//! the `sha2` dep — flip on a `verify` arg later if we want to enforce.

use std::path::{Path, PathBuf};

use futures::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::error::DictationError;
use crate::models::ModelId;

/// One progress tick from the download stream.
#[derive(Debug, Clone, Copy)]
pub struct DownloadProgress {
    /// Bytes received so far.
    pub downloaded: u64,
    /// Total bytes if the server returned `Content-Length`. Older
    /// proxies can omit this; the UI handles `None` by showing an
    /// indeterminate spinner.
    pub total: Option<u64>,
}

/// Download `model` into `models_dir`. Returns the final path.
///
/// `on_progress` is called from the same task that drives the byte
/// stream; it should be cheap (frontend emit, log line, etc.).
pub async fn download_model<F>(
    model: ModelId,
    models_dir: &Path,
    mut on_progress: F,
) -> Result<PathBuf, DictationError>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    tokio::fs::create_dir_all(models_dir).await?;

    let final_path = model.path_in(models_dir);
    if final_path.exists() {
        // Already downloaded — short-circuit and emit a single
        // "complete" progress tick so the UI immediately collapses
        // any in-flight progress bar.
        if let Ok(meta) = tokio::fs::metadata(&final_path).await {
            on_progress(DownloadProgress {
                downloaded: meta.len(),
                total: Some(meta.len()),
            });
        }
        return Ok(final_path);
    }

    let tmp_path: PathBuf = {
        let mut p = final_path.clone().into_os_string();
        p.push(".tmp");
        PathBuf::from(p)
    };

    let url = model.download_url();
    tracing::info!(model = ?model, %url, "downloading whisper model");
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await?
        .error_for_status()?;

    let total = resp.content_length();
    let mut stream = resp.bytes_stream();

    let mut file = tokio::fs::File::create(&tmp_path).await?;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        file.write_all(&bytes).await?;
        downloaded += bytes.len() as u64;
        on_progress(DownloadProgress { downloaded, total });
    }
    file.flush().await?;
    drop(file);

    tokio::fs::rename(&tmp_path, &final_path).await?;
    tracing::info!(path = %final_path.display(), bytes = downloaded, "model download complete");

    Ok(final_path)
}
