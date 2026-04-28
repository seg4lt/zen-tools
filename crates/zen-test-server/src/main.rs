//! Mock backend used by the example `.http` files.
//!
//! Boots an axum server on `0.0.0.0:3000` exposing CRUD users, login,
//! cookie-based sessions, form-urlencoded echo, custom-headers, slow /
//! random-delay endpoints (for perf testing), and a health check. This
//! is a development convenience only — `examples/http-client.env.json`
//! already points the `development` env at `http://localhost:3000`.
//!
//! Run with:
//!
//! ```bash
//! cargo run -p zen-test-server
//! ```

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};

/// Request logging is disabled by default so we don't bottleneck on
/// stdout when this server is hammered by the perf engine. Flip to
/// `true` for ad-hoc debugging.
const ENABLE_REQUEST_LOGGING: bool = false;

async fn log_request(req: axum::extract::Request, next: Next) -> Response {
    if !ENABLE_REQUEST_LOGGING {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let uri = req.uri().clone();
    let ts = chrono::Local::now().format("%H:%M:%S");
    println!("[{ts}] --> {method} {uri}");
    let response = next.run(req).await;
    let status = response.status();
    let color = if status.is_success() {
        "\x1b[32m"
    } else if status.is_client_error() {
        "\x1b[33m"
    } else {
        "\x1b[31m"
    };
    println!(
        "[{ts}] <-- {color}{}\x1b[0m {method} {uri}",
        status.as_u16()
    );
    response
}

#[derive(Clone, Serialize, Deserialize)]
struct User {
    id: u32,
    name: String,
    email: String,
}

#[derive(Serialize, Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
struct LoginResponse {
    accessToken: String,
    userId: u32,
    message: String,
}

#[derive(Serialize)]
struct MessageResponse {
    message: String,
}

#[derive(Clone)]
struct AppState {
    users: Arc<RwLock<HashMap<u32, User>>>,
    tokens: Arc<RwLock<HashMap<String, u32>>>,
    next_id: Arc<RwLock<u32>>,
}

impl Default for AppState {
    fn default() -> Self {
        let mut users = HashMap::new();
        users.insert(
            1,
            User {
                id: 1,
                name: "John Doe".into(),
                email: "john@example.com".into(),
            },
        );
        users.insert(
            2,
            User {
                id: 2,
                name: "Jane Smith".into(),
                email: "jane@example.com".into(),
            },
        );
        Self {
            users: Arc::new(RwLock::new(users)),
            tokens: Arc::new(RwLock::new(HashMap::new())),
            next_id: Arc::new(RwLock::new(3)),
        }
    }
}

#[tokio::main]
async fn main() {
    let state = AppState::default();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
        ])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    let app = Router::new()
        // Users
        .route("/api/users", get(get_users))
        .route("/api/users", post(create_user))
        .route("/api/users/:id", get(get_user))
        .route("/api/users/:id", put(update_user))
        .route("/api/users/:id", delete(delete_user))
        .route("/api/users/me", get(get_current_user))
        .route("/api/users/me", put(update_current_user))
        // Auth
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        // Cookie-based session
        .route("/api/session/start", post(start_session))
        .route("/api/session/check", get(check_session))
        // Form/URL-encoded
        .route("/api/oauth/callback", get(oauth_callback))
        .route("/api/form/echo", post(form_echo))
        // Echo / debug
        .route("/api/echo", post(echo_request))
        .route("/api/headers", get(headers_info))
        // Performance helpers
        .route("/api/slow", get(slow_response))
        .route("/api/random-delay", get(random_delay_response))
        // Health
        .route("/health", get(health))
        .layer(middleware::from_fn(log_request))
        .layer(cors)
        .with_state(state);

    let addr = "0.0.0.0:3000";
    println!("🚀 zen-test-server running at http://{addr}");
    println!();
    println!("Endpoints:");
    println!("  GET    /api/users               - list users");
    println!("  POST   /api/users               - create user");
    println!("  GET    /api/users/:id           - get one");
    println!("  PUT    /api/users/:id           - update");
    println!("  DELETE /api/users/:id           - delete");
    println!("  GET    /api/users/me            - current user (Bearer token)");
    println!("  PUT    /api/users/me            - update current user");
    println!("  POST   /api/auth/login          - login (returns accessToken)");
    println!("  POST   /api/auth/logout         - logout");
    println!("  POST   /api/session/start       - start session (Set-Cookie)");
    println!("  GET    /api/session/check       - check session cookie");
    println!("  GET    /api/oauth/callback      - form-urlencoded response");
    println!("  POST   /api/form/echo           - echo form-urlencoded body");
    println!("  POST   /api/echo                - echo headers + body as JSON");
    println!("  GET    /api/headers             - returns custom headers");
    println!("  GET    /api/slow?ms=100         - slow response (default 100ms)");
    println!("  GET    /api/random-delay        - random 1-2000ms delay");
    println!("  GET    /health                  - health check");
    println!();
    println!("Test credentials: any email with password \"password123\".");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind 0.0.0.0:3000");
    axum::serve(listener, app)
        .await
        .expect("axum::serve failed");
}

// ────────────────────────────────────────────────────────────────────────
// Health
// ────────────────────────────────────────────────────────────────────────

async fn health() -> impl IntoResponse {
    Json(MessageResponse {
        message: "OK".into(),
    })
}

// ────────────────────────────────────────────────────────────────────────
// Users
// ────────────────────────────────────────────────────────────────────────

async fn get_users(State(state): State<AppState>) -> impl IntoResponse {
    let users = state.users.read().unwrap();
    let users_vec: Vec<User> = users.values().cloned().collect();
    Json(users_vec)
}

async fn get_user(State(state): State<AppState>, Path(id): Path<u32>) -> impl IntoResponse {
    let users = state.users.read().unwrap();
    match users.get(&id) {
        Some(user) => (StatusCode::OK, Json(serde_json::to_value(user).unwrap())).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "User not found" })),
        )
            .into_response(),
    }
}

async fn create_user(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut users = state.users.write().unwrap();
    let mut next_id = state.next_id.write().unwrap();
    let id = *next_id;
    *next_id += 1;
    let user = User {
        id,
        name: payload
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown")
            .into(),
        email: payload
            .get("email")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown@example.com")
            .into(),
    };
    users.insert(id, user.clone());
    (StatusCode::CREATED, Json(user))
}

async fn update_user(
    State(state): State<AppState>,
    Path(id): Path<u32>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut users = state.users.write().unwrap();
    match users.get_mut(&id) {
        Some(user) => {
            if let Some(name) = payload.get("name").and_then(|v| v.as_str()) {
                user.name = name.into();
            }
            if let Some(email) = payload.get("email").and_then(|v| v.as_str()) {
                user.email = email.into();
            }
            (
                StatusCode::OK,
                Json(serde_json::to_value(user.clone()).unwrap()),
            )
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "User not found" })),
        )
            .into_response(),
    }
}

async fn delete_user(State(state): State<AppState>, Path(id): Path<u32>) -> impl IntoResponse {
    let mut users = state.users.write().unwrap();
    match users.remove(&id) {
        Some(_) => StatusCode::NO_CONTENT.into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "User not found" })),
        )
            .into_response(),
    }
}

// ────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────

async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> impl IntoResponse {
    if payload.password != "password123" {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid credentials" })),
        )
            .into_response();
    }
    let token = format!("token_{}", uuid::Uuid::new_v4());
    let user_id = 1;
    state
        .tokens
        .write()
        .unwrap()
        .insert(token.clone(), user_id);
    (
        StatusCode::OK,
        Json(LoginResponse {
            accessToken: token,
            userId: user_id,
            message: "Login successful".into(),
        }),
    )
        .into_response()
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        if let Ok(s) = auth.to_str() {
            let token = s.trim_start_matches("Bearer ");
            state.tokens.write().unwrap().remove(token);
        }
    }
    Json(MessageResponse {
        message: "Logged out".into(),
    })
}

fn extract_user_id(state: &AppState, headers: &HeaderMap) -> Option<u32> {
    let auth = headers.get(header::AUTHORIZATION)?;
    let s = auth.to_str().ok()?;
    let token = s.trim_start_matches("Bearer ");
    state.tokens.read().unwrap().get(token).copied()
}

async fn get_current_user(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    match extract_user_id(&state, &headers) {
        Some(uid) => {
            let users = state.users.read().unwrap();
            match users.get(&uid) {
                Some(user) => {
                    (StatusCode::OK, Json(serde_json::to_value(user).unwrap())).into_response()
                }
                None => (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "User not found" })),
                )
                    .into_response(),
            }
        }
        None => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Unauthorized" })),
        )
            .into_response(),
    }
}

async fn update_current_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    match extract_user_id(&state, &headers) {
        Some(uid) => {
            let mut users = state.users.write().unwrap();
            match users.get_mut(&uid) {
                Some(user) => {
                    if let Some(name) = payload.get("name").and_then(|v| v.as_str()) {
                        user.name = name.into();
                    }
                    if let Some(email) = payload.get("email").and_then(|v| v.as_str()) {
                        user.email = email.into();
                    }
                    (
                        StatusCode::OK,
                        Json(serde_json::to_value(user.clone()).unwrap()),
                    )
                        .into_response()
                }
                None => (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "User not found" })),
                )
                    .into_response(),
            }
        }
        None => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Unauthorized" })),
        )
            .into_response(),
    }
}

// ────────────────────────────────────────────────────────────────────────
// Cookie / session
// ────────────────────────────────────────────────────────────────────────

async fn start_session() -> impl IntoResponse {
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            format!("session_id={session_id}; Path=/; HttpOnly"),
        )],
        Json(serde_json::json!({
            "message": "Session started",
            "sessionId": session_id,
        })),
    )
}

async fn check_session(headers: HeaderMap) -> impl IntoResponse {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let session_id = cookie.split(';').find_map(|part| {
        let part = part.trim();
        part.strip_prefix("session_id=").map(str::to_owned)
    });
    match session_id {
        Some(id) => Json(serde_json::json!({
            "authenticated": true,
            "sessionId": id,
            "receivedCookie": cookie,
        }))
        .into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "authenticated": false,
                "error": "No session cookie found",
                "receivedCookie": cookie,
            })),
        )
            .into_response(),
    }
}

// ────────────────────────────────────────────────────────────────────────
// Form / URL-encoded
// ────────────────────────────────────────────────────────────────────────

async fn oauth_callback() -> impl IntoResponse {
    let code = format!("auth_code_{}", uuid::Uuid::new_v4());
    let state = "random_state_123";
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/x-www-form-urlencoded")],
        format!("code={code}&state={state}&token_type=bearer"),
    )
}

async fn form_echo(body: Bytes) -> impl IntoResponse {
    let body_str = String::from_utf8_lossy(&body).to_string();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/x-www-form-urlencoded")],
        body_str,
    )
}

// ────────────────────────────────────────────────────────────────────────
// Echo / debug
// ────────────────────────────────────────────────────────────────────────

async fn echo_request(headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let mut header_map: HashMap<String, String> = HashMap::new();
    for (k, v) in headers.iter() {
        if let Ok(s) = v.to_str() {
            header_map.insert(k.to_string(), s.to_string());
        }
    }
    let body_str = String::from_utf8_lossy(&body).to_string();
    let body_json: serde_json::Value = serde_json::from_str(&body_str)
        .unwrap_or_else(|_| serde_json::Value::String(body_str.clone()));
    Json(serde_json::json!({
        "headers": header_map,
        "body": body_json,
        "bodyRaw": body_str,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }))
}

async fn headers_info() -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            ("X-Request-Id", format!("req_{}", uuid::Uuid::new_v4())),
            ("X-RateLimit-Limit", "1000".into()),
            ("X-RateLimit-Remaining", "999".into()),
            ("X-Server-Version", "1.2.3".into()),
            ("X-Custom-Header", "custom-value-here".into()),
        ],
        Json(serde_json::json!({
            "message": "Check the response headers!",
            "hint": "Use $header.X-RateLimit-Remaining to extract header values",
        })),
    )
}

// ────────────────────────────────────────────────────────────────────────
// Performance
// ────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SlowParams {
    #[serde(default = "default_delay")]
    ms: u64,
}

fn default_delay() -> u64 {
    100
}

async fn slow_response(Query(params): Query<SlowParams>) -> impl IntoResponse {
    tokio::time::sleep(Duration::from_millis(params.ms)).await;
    Json(serde_json::json!({
        "message": "Slow response completed",
        "delay_ms": params.ms,
    }))
}

async fn random_delay_response() -> impl IntoResponse {
    use rand::Rng;
    let delay_ms = rand::rng().random_range(1..=2000u64);
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    Json(serde_json::json!({
        "message": "Random delay response completed",
        "delay_ms": delay_ms,
    }))
}
