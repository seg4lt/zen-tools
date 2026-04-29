//! Assertion DSL evaluated against an [`HttpResponse`] after each request.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use zen_types::response::HttpResponse;

/// Comparison operators for the numeric forms of assertions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompareOp {
    /// `<`
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
    /// `==`
    Eq,
    /// `!=`
    Ne,
}

impl CompareOp {
    fn evaluate(&self, left: f64, right: f64) -> bool {
        match self {
            CompareOp::Lt => left < right,
            CompareOp::Le => left <= right,
            CompareOp::Gt => left > right,
            CompareOp::Ge => left >= right,
            CompareOp::Eq => (left - right).abs() < f64::EPSILON,
            CompareOp::Ne => (left - right).abs() >= f64::EPSILON,
        }
    }
}

/// One supported assertion form.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Assertion {
    /// `status = 200`
    StatusEquals(u16),
    /// `status in 200..299`
    StatusInRange(u16, u16),
    /// `body contains "foo"`
    BodyContains(String),
    /// `body not contains "foo"`
    BodyNotContains(String),
    /// `body.path = "value"`
    JsonPathEquals {
        /// Dot-separated path into the JSON body.
        path: String,
        /// String value to compare against.
        value: String,
    },
    /// `body.path > 0` (and the rest of the operators)
    JsonPathCompare {
        /// Dot-separated path into the JSON body.
        path: String,
        /// Comparison operator.
        op: CompareOp,
        /// Number to compare against.
        value: f64,
    },
    /// `response_time < 500`
    ResponseTimeUnder(u64),
}

/// Outcome of evaluating a single assertion.
#[derive(Debug, Clone)]
pub struct AssertionResult {
    /// The original assertion (for display).
    pub assertion: Assertion,
    /// `true` if the assertion held.
    pub passed: bool,
    /// The actual value seen.
    pub actual_value: Option<String>,
    /// Human-readable message.
    pub message: String,
}

static STATUS_EQ: Lazy<Regex> = Lazy::new(|| Regex::new(r"^status\s*=\s*(\d+)$").unwrap());
static STATUS_RANGE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^status\s+in\s+(\d+)\.\.(\d+)$").unwrap());
static BODY_CONTAINS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"^body\s+contains\s+"([^"]+)"$"#).unwrap());
static BODY_NOT_CONTAINS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"^body\s+not\s+contains\s+"([^"]+)"$"#).unwrap());
static RESPONSE_TIME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^response_time\s*<\s*(\d+)$").unwrap());
static JSON_PATH_EQ: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"^body\.(\S+)\s*=\s*"([^"]*)"$"#).unwrap());
static JSON_PATH_CMP: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^body\.(\S+)\s*([<>=!]+)\s*(-?\d+\.?\d*)$").unwrap());

impl Assertion {
    /// Parse an assertion from its raw string form.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();

        if let Some(caps) = STATUS_EQ.captures(s) {
            let code: u16 = caps.get(1)?.as_str().parse().ok()?;
            return Some(Assertion::StatusEquals(code));
        }
        if let Some(caps) = STATUS_RANGE.captures(s) {
            let start: u16 = caps.get(1)?.as_str().parse().ok()?;
            let end: u16 = caps.get(2)?.as_str().parse().ok()?;
            return Some(Assertion::StatusInRange(start, end));
        }
        if let Some(caps) = BODY_CONTAINS.captures(s) {
            return Some(Assertion::BodyContains(caps.get(1)?.as_str().to_string()));
        }
        if let Some(caps) = BODY_NOT_CONTAINS.captures(s) {
            return Some(Assertion::BodyNotContains(
                caps.get(1)?.as_str().to_string(),
            ));
        }
        if let Some(caps) = RESPONSE_TIME.captures(s) {
            let ms: u64 = caps.get(1)?.as_str().parse().ok()?;
            return Some(Assertion::ResponseTimeUnder(ms));
        }
        if let Some(caps) = JSON_PATH_EQ.captures(s) {
            return Some(Assertion::JsonPathEquals {
                path: caps.get(1)?.as_str().to_string(),
                value: caps.get(2)?.as_str().to_string(),
            });
        }
        if let Some(caps) = JSON_PATH_CMP.captures(s) {
            let path = caps.get(1)?.as_str().to_string();
            let op_str = caps.get(2)?.as_str();
            let value: f64 = caps.get(3)?.as_str().parse().ok()?;
            let op = match op_str {
                "<" => CompareOp::Lt,
                "<=" => CompareOp::Le,
                ">" => CompareOp::Gt,
                ">=" => CompareOp::Ge,
                "==" | "=" => CompareOp::Eq,
                "!=" => CompareOp::Ne,
                _ => return None,
            };
            return Some(Assertion::JsonPathCompare { path, op, value });
        }

        None
    }

    /// Evaluate against a response + measured duration.
    pub fn evaluate(&self, response: &HttpResponse, duration: Duration) -> AssertionResult {
        match self {
            Assertion::StatusEquals(expected) => {
                let passed = response.status_code == *expected;
                AssertionResult {
                    assertion: self.clone(),
                    passed,
                    actual_value: Some(response.status_code.to_string()),
                    message: if passed {
                        format!("Status {} == {}", response.status_code, expected)
                    } else {
                        format!("Expected status {expected}, got {}", response.status_code)
                    },
                }
            }
            Assertion::StatusInRange(start, end) => {
                let passed = response.status_code >= *start && response.status_code <= *end;
                AssertionResult {
                    assertion: self.clone(),
                    passed,
                    actual_value: Some(response.status_code.to_string()),
                    message: if passed {
                        format!("Status {} in {start}..{end}", response.status_code)
                    } else {
                        format!(
                            "Status {} not in range {start}..{end}",
                            response.status_code
                        )
                    },
                }
            }
            Assertion::BodyContains(text) => {
                let passed = response.body.contains(text);
                AssertionResult {
                    assertion: self.clone(),
                    passed,
                    actual_value: Some(snippet(&response.body)),
                    message: if passed {
                        format!("Body contains \"{text}\"")
                    } else {
                        format!("Body does not contain \"{text}\"")
                    },
                }
            }
            Assertion::BodyNotContains(text) => {
                let passed = !response.body.contains(text);
                AssertionResult {
                    assertion: self.clone(),
                    passed,
                    actual_value: Some(snippet(&response.body)),
                    message: if passed {
                        format!("Body does not contain \"{text}\"")
                    } else {
                        format!("Body unexpectedly contains \"{text}\"")
                    },
                }
            }
            Assertion::JsonPathEquals { path, value } => {
                let actual = extract_json_path(&response.body, path);
                let passed = actual.as_ref() == Some(value);
                AssertionResult {
                    assertion: self.clone(),
                    passed,
                    actual_value: actual.clone(),
                    message: if passed {
                        format!("body.{path} == \"{value}\"")
                    } else {
                        format!("Expected body.{path} = \"{value}\", got {actual:?}")
                    },
                }
            }
            Assertion::JsonPathCompare { path, op, value } => {
                let actual =
                    extract_json_path(&response.body, path).and_then(|s| s.parse::<f64>().ok());
                let passed = actual.is_some_and(|a| op.evaluate(a, *value));
                let op_str = match op {
                    CompareOp::Lt => "<",
                    CompareOp::Le => "<=",
                    CompareOp::Gt => ">",
                    CompareOp::Ge => ">=",
                    CompareOp::Eq => "==",
                    CompareOp::Ne => "!=",
                };
                AssertionResult {
                    assertion: self.clone(),
                    passed,
                    actual_value: actual.map(|v| v.to_string()),
                    message: if passed {
                        format!("body.{path} {op_str} {value}")
                    } else {
                        format!("Expected body.{path} {op_str} {value}, got {actual:?}")
                    },
                }
            }
            Assertion::ResponseTimeUnder(max_ms) => {
                let actual_ms = duration.as_millis() as u64;
                let passed = actual_ms < *max_ms;
                AssertionResult {
                    assertion: self.clone(),
                    passed,
                    actual_value: Some(format!("{actual_ms}ms")),
                    message: if passed {
                        format!("Response time {actual_ms}ms < {max_ms}ms")
                    } else {
                        format!("Response time {actual_ms}ms >= {max_ms}ms limit")
                    },
                }
            }
        }
    }
}

fn snippet(body: &str) -> String {
    let cap = body.len().min(100);
    format!("{}...", &body[..cap])
}

fn extract_json_path(json: &str, path: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut current = &value;
    for part in path.split('.') {
        match current {
            serde_json::Value::Object(map) => current = map.get(part)?,
            serde_json::Value::Array(arr) => {
                let idx: usize = part.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(match current {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => "null".into(),
        other => other.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_response(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status_code: status,
            status_text: "OK".into(),
            headers: Vec::new(),
            body: body.into(),
            duration: Duration::from_millis(50),
            size_bytes: body.len(),
        }
    }

    #[test]
    fn parses_all_supported_forms() {
        assert!(matches!(
            Assertion::parse("status = 200"),
            Some(Assertion::StatusEquals(200))
        ));
        assert!(matches!(
            Assertion::parse("status in 200..299"),
            Some(Assertion::StatusInRange(200, 299))
        ));
        assert!(matches!(
            Assertion::parse(r#"body contains "users""#),
            Some(Assertion::BodyContains(s)) if s == "users"
        ));
        assert!(matches!(
            Assertion::parse("response_time < 500"),
            Some(Assertion::ResponseTimeUnder(500))
        ));
        assert!(matches!(
            Assertion::parse(r#"body.status = "ok""#),
            Some(Assertion::JsonPathEquals { ref path, ref value })
                if path == "status" && value == "ok"
        ));
        assert!(matches!(
            Assertion::parse("body.length > 0"),
            Some(Assertion::JsonPathCompare {
                ref path,
                op: CompareOp::Gt,
                value
            }) if path == "length" && value == 0.0
        ));
    }

    #[test]
    fn evaluates_status_and_body() {
        let r = mock_response(200, r#"{"users":[]}"#);
        assert!(
            Assertion::StatusEquals(200)
                .evaluate(&r, Duration::from_millis(50))
                .passed
        );
        assert!(
            Assertion::BodyContains("users".into())
                .evaluate(&r, Duration::from_millis(50))
                .passed
        );
    }

    #[test]
    fn evaluates_response_time() {
        let r = mock_response(200, "{}");
        let a = Assertion::ResponseTimeUnder(100);
        assert!(a.evaluate(&r, Duration::from_millis(50)).passed);
        assert!(!a.evaluate(&r, Duration::from_millis(150)).passed);
    }
}
