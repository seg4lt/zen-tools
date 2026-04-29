//! Variable substitution and JSON/header/form extraction helpers.
//!
//! These functions are used both during request rendering (to fill in
//! `{{placeholders}}`) and post-response (to pull values out for `@extract`
//! annotations).

use ahash::HashMap;
use once_cell::sync::Lazy;
use regex::Regex;
use std::borrow::Cow;

/// Where the `@extract` value should be pulled from.
pub enum ExtractionSource {
    /// JSON body — JSONPath / dot-notation.
    Json(String),
    /// Response header (case-insensitive).
    Header(String),
    /// `application/x-www-form-urlencoded` body field.
    Form(String),
}

/// Classify an extraction path string.
pub fn parse_extraction_path(path: &str) -> ExtractionSource {
    if let Some(name) = path.strip_prefix("$header.") {
        ExtractionSource::Header(name.to_string())
    } else if let Some(name) = path.strip_prefix("$form.") {
        ExtractionSource::Form(name.to_string())
    } else {
        ExtractionSource::Json(path.to_string())
    }
}

/// Case-insensitive header lookup.
pub fn extract_header_value<S: ::std::hash::BuildHasher>(
    headers: &std::collections::HashMap<String, String, S>,
    header_name: &str,
) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(header_name))
        .map(|(_, v)| v.clone())
}

/// Same case-insensitive lookup, but for the ahash variant.
pub fn extract_header_value_ahash(
    headers: &HashMap<String, String>,
    header_name: &str,
) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(header_name))
        .map(|(_, v)| v.clone())
}

/// Case-insensitive lookup against an ordered `(name, value)` list.
/// Returns the first match — appropriate for headers like
/// `Authorization` where only one value is expected.
pub fn extract_header_from_pairs(
    headers: &[(String, String)],
    header_name: &str,
) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(header_name))
        .map(|(_, v)| v.clone())
}

/// Extract one field from a URL-encoded form body.
pub fn extract_form_value(body: &str, field_name: &str) -> Option<String> {
    for pair in body.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            if key == field_name {
                return urlencoding::decode(value).ok().map(|s| s.into_owned());
            }
        }
    }
    None
}

static VAR_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{\{([^}]+)\}\}").unwrap());

/// Variable resolver — exposes an instance API for callers that want to
/// reuse the compiled regex (which is the same `static` pattern under the
/// hood, so the optimisation is mostly stylistic).
pub struct VariableResolver;

impl Default for VariableResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl VariableResolver {
    /// Construct a resolver. The regex is shared globally.
    pub const fn new() -> Self {
        Self
    }

    /// Substitute `{{var}}` placeholders. Priority: extracted > local > env.
    /// Returns a [`Cow`] — borrowed when the input had no placeholders.
    pub fn substitute<'a>(
        &self,
        text: &'a str,
        extracted: &HashMap<String, String>,
        local: &HashMap<String, String>,
        env: &HashMap<String, String>,
    ) -> Cow<'a, str> {
        if !VAR_PATTERN.is_match(text) {
            return Cow::Borrowed(text);
        }
        let replaced = VAR_PATTERN.replace_all(text, |caps: &regex::Captures| {
            let name = caps.get(1).unwrap().as_str().trim();
            resolve_one(name, extracted, local, env)
        });
        Cow::Owned(replaced.into_owned())
    }

    /// All `{{name}}` references found in the text.
    pub fn find_variables(&self, text: &str) -> Vec<String> {
        VAR_PATTERN
            .captures_iter(text)
            .map(|caps| caps.get(1).unwrap().as_str().trim().to_string())
            .collect()
    }

    /// `true` if the text still contains any placeholders.
    pub fn has_unresolved(&self, text: &str) -> bool {
        VAR_PATTERN.is_match(text)
    }
}

fn resolve_one(
    name: &str,
    extracted: &HashMap<String, String>,
    local: &HashMap<String, String>,
    env: &HashMap<String, String>,
) -> String {
    if let Some(v) = extracted.get(name) {
        return v.clone();
    }
    if let Some(v) = local.get(name) {
        return v.clone();
    }
    if let Some(v) = env.get(name) {
        return v.clone();
    }
    format!("{{{{{name}}}}}")
}

/// Convenience wrapper that handles the two-pass resolution required when
/// local variables themselves reference env variables (e.g.
/// `@baseUrl = {{host}}/api`).
pub fn substitute_variables(
    text: &str,
    extracted: &HashMap<String, String>,
    local: &HashMap<String, String>,
    env: &HashMap<String, String>,
) -> String {
    let resolver = VariableResolver::new();
    let empty: HashMap<String, String> = HashMap::default();

    // First, resolve env into local values so {{baseUrl}} can refer to {{host}}.
    let resolved_local: HashMap<String, String> = local
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                resolver.substitute(v, extracted, &empty, env).into_owned(),
            )
        })
        .collect();

    resolver
        .substitute(text, extracted, &resolved_local, env)
        .into_owned()
}

/// Resolve a JSON body + dot-path (or `$.path`) into a string.
pub fn extract_json_value(json: &str, json_path: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let path = json_path.trim_start_matches("$.");
    let parts: Vec<&str> = path.split('.').collect();

    let mut current = &value;
    for part in parts {
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
        serde_json::Value::Null => "null".to_string(),
        other => other.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ahash::HashMapExt;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        let mut h = HashMap::with_capacity(pairs.len());
        for (k, v) in pairs {
            h.insert((*k).to_string(), (*v).to_string());
        }
        h
    }

    #[test]
    fn substitutes_basic_placeholder() {
        let env = map(&[("host", "localhost:8080"), ("token", "abc123")]);
        let result = substitute_variables(
            "http://{{host}}/api",
            &HashMap::default(),
            &HashMap::default(),
            &env,
        );
        assert_eq!(result, "http://localhost:8080/api");
    }

    #[test]
    fn priority_extracted_over_local_over_env() {
        let extracted = map(&[("token", "extracted")]);
        let local = map(&[("token", "local")]);
        let env = map(&[("token", "env")]);
        assert_eq!(
            substitute_variables("{{token}}", &extracted, &local, &env),
            "extracted"
        );
        assert_eq!(
            substitute_variables("{{token}}", &HashMap::default(), &local, &env),
            "local"
        );
        assert_eq!(
            substitute_variables("{{token}}", &HashMap::default(), &HashMap::default(), &env),
            "env"
        );
    }

    #[test]
    fn nested_local_references_env() {
        let env = map(&[("host", "http://localhost:3000")]);
        let local = map(&[("baseUrl", "{{host}}/api")]);
        assert_eq!(
            substitute_variables("{{baseUrl}}/users", &HashMap::default(), &local, &env),
            "http://localhost:3000/api/users"
        );
    }

    #[test]
    fn extracts_json_values() {
        let json = r#"{"token":"abc","data":{"id":1,"name":"test"}}"#;
        assert_eq!(extract_json_value(json, "$.token"), Some("abc".into()));
        assert_eq!(extract_json_value(json, "token"), Some("abc".into()));
        assert_eq!(extract_json_value(json, "data.id"), Some("1".into()));
        assert_eq!(extract_json_value(json, "data.name"), Some("test".into()));
    }
}
