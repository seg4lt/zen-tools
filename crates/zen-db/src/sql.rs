//! SQL text utilities shared across the database tool.
//!
//! The Database Explorer's "Run all" action splits the editor buffer
//! into individual statements before sending them to the driver. This
//! module owns the splitter so it lives next to the rest of the SQL
//! domain logic.

/// Split a SQL string on top-level `;`, respecting `'...'` and `"..."`
/// strings, `--` line comments, and `/* ... */` block comments.
///
/// Empty / whitespace-only trailing chunks are dropped (a trailing `;`
/// doesn't produce an extra blank statement).
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while i < bytes.len() {
        let c = bytes[i] as char;
        let next = bytes.get(i + 1).copied().map(|b| b as char);

        if in_line_comment {
            cur.push(c);
            if c == '\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            cur.push(c);
            if c == '*' && next == Some('/') {
                cur.push('/');
                i += 2;
                in_block_comment = false;
                continue;
            }
            i += 1;
            continue;
        }
        if in_single {
            cur.push(c);
            if c == '\'' {
                // SQL '' = escaped quote inside string literal.
                if next == Some('\'') {
                    cur.push('\'');
                    i += 2;
                    continue;
                }
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            cur.push(c);
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }

        match c {
            '-' if next == Some('-') => {
                in_line_comment = true;
                cur.push_str("--");
                i += 2;
            }
            '/' if next == Some('*') => {
                in_block_comment = true;
                cur.push_str("/*");
                i += 2;
            }
            '\'' => {
                in_single = true;
                cur.push(c);
                i += 1;
            }
            '"' => {
                in_double = true;
                cur.push(c);
                i += 1;
            }
            ';' => {
                out.push(std::mem::take(&mut cur));
                i += 1;
            }
            _ => {
                cur.push(c);
                i += 1;
            }
        }
    }

    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_simple() {
        let out = split_statements("SELECT 1; SELECT 2");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].trim(), "SELECT 1");
        assert_eq!(out[1].trim(), "SELECT 2");
    }

    #[test]
    fn ignores_semicolon_in_string() {
        let out = split_statements("SELECT ';'; SELECT 2");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].trim(), "SELECT ';'");
    }

    #[test]
    fn ignores_semicolon_in_line_comment() {
        let out = split_statements("SELECT 1 -- ;\n; SELECT 2");
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn ignores_semicolon_in_block_comment() {
        let out = split_statements("SELECT 1 /* ; foo ; */; SELECT 2");
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("/* ; foo ; */"));
    }

    #[test]
    fn handles_escaped_quotes() {
        let out = split_statements("SELECT 'it''s; ok'; SELECT 2");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].trim(), "SELECT 'it''s; ok'");
    }

    #[test]
    fn trailing_semicolon_is_not_extra_statement() {
        let out = split_statements("SELECT 1;");
        assert_eq!(out.len(), 1);
    }
}
