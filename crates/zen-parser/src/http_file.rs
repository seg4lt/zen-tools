//! Parser for IntelliJ-style `.http` / `.rest` files.

use once_cell::sync::Lazy;
use regex::Regex;
use tracing::trace;
use zen_types::prelude::*;

/// Regex set used by the parser. Compiled once per process via `Lazy` so we
/// pay the compilation cost a single time even when many files are parsed
/// in succession.
struct HttpRegexes {
    name: Regex,
    depends: Regex,
    extract: Regex,
    assert: Regex,
    in_place_var: Regex,
    header: Regex,
    request_line: Regex,
}

static REGEXES: Lazy<HttpRegexes> = Lazy::new(|| HttpRegexes {
    name: Regex::new(r"^#\s*@name\s+(.+)$").unwrap(),
    depends: Regex::new(r"^#\s*@depends\s+(.+)$").unwrap(),
    extract: Regex::new(r"^#\s*@extract\s+(\w+)\s*=\s*(.+)$").unwrap(),
    assert: Regex::new(r"^#\s*@assert\s+(.+)$").unwrap(),
    in_place_var: Regex::new(r"^@(\w+)\s*=\s*(.+)$").unwrap(),
    header: Regex::new(r"^([A-Za-z0-9-]+):\s*(.+)$").unwrap(),
    request_line: Regex::new(
        r"^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+?)(?:\s+HTTP/[\d.]+)?$",
    )
    .unwrap(),
});

/// Parse the contents of an `.http` file. The `path` is recorded on the
/// returned `HttpFile` and propagated as `source_file` on each request, so
/// stable IDs work after re-parses.
#[tracing::instrument(skip(content), fields(path = %path))]
pub fn parse_http_file(path: &str, content: &str) -> HttpFile {
    let mut http_file = HttpFile::new(path.to_string());
    let lines: Vec<&str> = content.lines().collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();

        if let Some(caps) = REGEXES.in_place_var.captures(line) {
            let name = caps.get(1).unwrap().as_str().to_string();
            let value = caps.get(2).unwrap().as_str().trim().to_string();
            http_file.local_variables.insert(name, value);
            i += 1;
            continue;
        }

        if line.is_empty() || line == "###" {
            i += 1;
            continue;
        }

        if let Some((request, consumed)) = parse_request_block(&lines, i) {
            http_file.requests.push(request);
            i += consumed;
        } else {
            i += 1;
        }
    }

    let absolute = std::path::Path::new(path)
        .canonicalize()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.to_string());

    for request in &mut http_file.requests {
        request.source_file = Some(absolute.clone());
    }

    trace!(
        requests = http_file.requests.len(),
        locals = http_file.local_variables.len(),
        "parsed file"
    );

    http_file
}

fn parse_request_block(lines: &[&str], start: usize) -> Option<(HttpRequest, usize)> {
    let mut request = HttpRequest {
        line_number: start + 1,
        ..HttpRequest::default()
    };
    let mut i = start;
    let mut found_request_line = false;
    let mut in_body = false;
    let mut body_lines: Vec<String> = Vec::new();

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        if trimmed == "###" {
            i += 1;
            break;
        }

        if !found_request_line {
            if trimmed.starts_with('#') || trimmed.starts_with("//") {
                if let Some(caps) = REGEXES.name.captures(trimmed) {
                    request.name = Some(caps.get(1).unwrap().as_str().trim().to_string());
                } else if let Some(caps) = REGEXES.depends.captures(trimmed) {
                    let deps = caps.get(1).unwrap().as_str();
                    for dep in deps.split(',') {
                        let dep = dep.trim();
                        if !dep.is_empty() {
                            request.depends_on.push(DependencyRef::parse(dep));
                        }
                    }
                } else if let Some(caps) = REGEXES.extract.captures(trimmed) {
                    let var_name = caps.get(1).unwrap().as_str().to_string();
                    let path = caps.get(2).unwrap().as_str().trim().to_string();
                    request.extract.insert(var_name, path);
                } else if let Some(caps) = REGEXES.assert.captures(trimmed) {
                    request
                        .assertions
                        .push(caps.get(1).unwrap().as_str().trim().to_string());
                }
                i += 1;
                continue;
            }

            if let Some(caps) = REGEXES.request_line.captures(trimmed) {
                let method_str = caps.get(1).unwrap().as_str();
                let url = caps.get(2).unwrap().as_str().trim().to_string();
                if let Some(method) = HttpMethod::parse(method_str) {
                    request.method = method;
                    request.url = url;
                    found_request_line = true;
                    i += 1;
                    continue;
                }
            }

            if REGEXES.in_place_var.is_match(trimmed) {
                i += 1;
                continue;
            }

            if trimmed.is_empty() {
                i += 1;
                continue;
            }
        }

        if found_request_line && !in_body {
            if trimmed.is_empty() {
                in_body = true;
                i += 1;
                continue;
            }

            if let Some(caps) = REGEXES.header.captures(trimmed) {
                let key = caps.get(1).unwrap().as_str().to_string();
                let value = caps.get(2).unwrap().as_str().trim().to_string();
                request.headers.insert(key, value);
            }
            i += 1;
            continue;
        }

        if in_body {
            body_lines.push(line.to_string());
        }

        i += 1;
    }

    if !found_request_line {
        return None;
    }

    if !body_lines.is_empty() {
        let body = body_lines.join("\n").trim().to_string();
        if !body.is_empty() {
            request.body = Some(body);
        }
    }

    Some((request, i - start))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_get() {
        let content = "GET http://localhost:8080/api/users\n";
        let file = parse_http_file("test.http", content);
        assert_eq!(file.requests.len(), 1);
        assert_eq!(file.requests[0].method, HttpMethod::Get);
        assert_eq!(file.requests[0].url, "http://localhost:8080/api/users");
    }

    #[test]
    fn parses_name_and_depends() {
        let content = "# @name GetUsers\n# @depends Login\nGET http://x/users\nAuthorization: Bearer {{t}}\n";
        let file = parse_http_file("test.http", content);
        assert_eq!(file.requests[0].name.as_deref(), Some("GetUsers"));
        assert_eq!(
            file.requests[0].depends_on,
            vec![DependencyRef::Local {
                name: "Login".into()
            }]
        );
        assert!(file.requests[0].headers.contains_key("Authorization"));
    }

    #[test]
    fn parses_multiple_requests_with_separator() {
        let content = r#"# @name Login
POST http://x/auth
Content-Type: application/json

{"u":"a"}

###

# @name GetProfile
# @depends Login
GET http://x/profile
"#;
        let file = parse_http_file("test.http", content);
        assert_eq!(file.requests.len(), 2);
        assert_eq!(file.requests[0].name.as_deref(), Some("Login"));
        assert_eq!(file.requests[1].name.as_deref(), Some("GetProfile"));
    }

    #[test]
    fn parses_cross_file_dep() {
        let content = "# @name GetUsers\n# @depends auth.http:Login\nGET http://x/users\n";
        let file = parse_http_file("test.http", content);
        assert_eq!(
            file.requests[0].depends_on,
            vec![DependencyRef::CrossFile {
                file_path: "auth.http".into(),
                request_name: "Login".into(),
            }]
        );
    }

    #[test]
    fn parses_in_place_variables() {
        let content = "@baseUrl = http://x:8080\n@token = abc\n\nGET {{baseUrl}}/u\n";
        let file = parse_http_file("test.http", content);
        assert_eq!(
            file.local_variables.get("baseUrl"),
            Some(&"http://x:8080".to_string())
        );
        assert_eq!(file.local_variables.get("token"), Some(&"abc".to_string()));
    }

    #[test]
    fn parses_extract_annotations() {
        let content = "# @name Login\n# @extract token = $.accessToken\n# @extract userId = $.userId\nPOST http://x/auth\n";
        let file = parse_http_file("test.http", content);
        assert_eq!(
            file.requests[0].extract.get("token"),
            Some(&"$.accessToken".to_string())
        );
        assert_eq!(
            file.requests[0].extract.get("userId"),
            Some(&"$.userId".to_string())
        );
    }
}
