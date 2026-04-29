//! HTTP execution backed by `reqwest`.
//!
//! [`HttpExecutor`] is cheaply cloneable: the underlying `reqwest::Client`
//! holds its connection pool behind an `Arc`, so passing one to a tokio
//! task is a refcount bump.

use crate::error::HttpError;
use crate::variable::{
    extract_form_value, extract_header_from_pairs, extract_json_value, parse_extraction_path,
    substitute_variables, ExtractionSource,
};
use ahash::HashMap;
use ahash::HashMapExt;
use reqwest::Client;
use std::time::{Duration, Instant};
use tracing::{debug, instrument};
use zen_types::prelude::*;

/// HTTP executor with aggressive connection pooling.
#[derive(Clone)]
pub struct HttpExecutor {
    client: Client,
}

impl Default for HttpExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpExecutor {
    /// Build the executor with sane defaults for both interactive and
    /// load-test workloads (large pool, HTTP/2 keep-alive, TCP no-delay).
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(1000)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .http2_keep_alive_interval(Duration::from_secs(30))
            .http2_keep_alive_timeout(Duration::from_secs(20))
            .build()
            .expect("failed to build reqwest::Client");
        Self { client }
    }

    /// Execute a single request against the given variable context.
    ///
    /// Returns a [`RequestResult`]:
    /// * `success` if the request transport completed (regardless of HTTP
    ///   status code), with the response and any extracted variables;
    /// * `error` if the transport itself failed (DNS, connect, body read).
    #[instrument(skip_all, fields(method = %request.method, url = %request.url))]
    pub async fn execute(
        &self,
        request: &HttpRequest,
        extracted_vars: &HashMap<String, String>,
        local_vars: &HashMap<String, String>,
        env_vars: &HashMap<String, String>,
        cookies: &[(String, String)],
    ) -> RequestResult {
        let url = substitute_variables(&request.url, extracted_vars, local_vars, env_vars);

        let mut headers: HashMap<String, String> = HashMap::with_capacity(request.headers.len());
        for (k, v) in &request.headers {
            headers.insert(
                k.clone(),
                substitute_variables(v, extracted_vars, local_vars, env_vars),
            );
        }

        let body = request
            .body
            .as_ref()
            .map(|b| substitute_variables(b, extracted_vars, local_vars, env_vars));

        let start = Instant::now();
        let mut req = match request.method {
            HttpMethod::Get => self.client.get(&url),
            HttpMethod::Post => self.client.post(&url),
            HttpMethod::Put => self.client.put(&url),
            HttpMethod::Delete => self.client.delete(&url),
            HttpMethod::Patch => self.client.patch(&url),
            HttpMethod::Head => self.client.head(&url),
            HttpMethod::Options => self.client.request(reqwest::Method::OPTIONS, &url),
        };

        if !cookies.is_empty() {
            let cookie_header = cookies
                .iter()
                .map(|(n, v)| format!("{n}={v}"))
                .collect::<Vec<_>>()
                .join("; ");
            req = req.header("Cookie", cookie_header);
        }
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        if let Some(body_content) = body {
            req = req.body(body_content);
        }

        match req.send().await {
            Ok(response) => {
                let duration = start.elapsed();
                let status_code = response.status().as_u16();
                let status_text = response
                    .status()
                    .canonical_reason()
                    .unwrap_or("Unknown")
                    .to_string();

                // Vec (not a map) so duplicate-named headers — Set-Cookie,
                // Vary, repeated Cache-Control, etc. — all reach the UI.
                let mut response_headers: Vec<(String, String)> = Vec::new();
                let mut new_cookies = Vec::new();
                for (k, v) in response.headers() {
                    let Ok(value) = v.to_str() else { continue };
                    if k.as_str().eq_ignore_ascii_case("set-cookie") {
                        if let Some(c) = parse_set_cookie(value) {
                            new_cookies.push(c);
                        }
                    }
                    response_headers.push((k.to_string(), value.to_string()));
                }

                match response.text().await {
                    Ok(body) => {
                        let size_bytes = body.len();
                        let mut new_extracted: HashMap<String, String> = HashMap::default();
                        for (var_name, path) in &request.extract {
                            let value = match parse_extraction_path(path) {
                                ExtractionSource::Json(p) => extract_json_value(&body, &p),
                                ExtractionSource::Header(name) => {
                                    extract_header_from_pairs(&response_headers, &name)
                                }
                                ExtractionSource::Form(field) => extract_form_value(&body, &field),
                            };
                            if let Some(v) = value {
                                new_extracted.insert(var_name.clone(), v);
                            }
                        }
                        debug!(status = status_code, size = size_bytes, "response complete");
                        let response = HttpResponse {
                            status_code,
                            status_text,
                            headers: response_headers,
                            body,
                            duration,
                            size_bytes,
                        };
                        RequestResult::success(
                            request.stable_id(),
                            response,
                            new_extracted,
                            new_cookies,
                        )
                    }
                    Err(e) => RequestResult::error(
                        request.stable_id(),
                        format!("failed to read response body: {e}"),
                    ),
                }
            }
            Err(e) => {
                RequestResult::error(request.stable_id(), format!("request to {url} failed: {e}"))
            }
        }
    }
}

/// Parse a `Set-Cookie` header value to `(name, value)`. Anything beyond
/// `name=value` (Path, HttpOnly, Secure, …) is discarded.
fn parse_set_cookie(header: &str) -> Option<(String, String)> {
    let cookie_part = header.split(';').next()?;
    let (name, value) = cookie_part.split_once('=')?;
    Some((name.trim().to_string(), value.trim().to_string()))
}

/// Inert constructor for tests / convenience.
pub fn create_executor() -> HttpExecutor {
    HttpExecutor::new()
}

/// Convert [`HttpError`] into the user-visible string form used by
/// [`RequestResult::error`]. Kept here so callers don't need to depend on
/// `reqwest` directly.
pub fn http_error_message(err: HttpError) -> String {
    err.to_string()
}
