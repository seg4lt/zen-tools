//! Loading and substituting `perf.variable.yaml` placeholders.

use crate::error::ParserError;
use std::collections::HashMap;
use std::path::Path;

/// Variable map populated from one or more `perf.variable.yaml` files.
pub type PerfVariables = HashMap<String, serde_yaml::Value>;

/// Load a single `perf.variable.yaml` from disk.
pub fn load_perf_variables(path: &Path) -> Result<PerfVariables, ParserError> {
    let content = std::fs::read_to_string(path).map_err(|source| ParserError::Io {
        path: path.display().to_string(),
        source,
    })?;
    serde_yaml::from_str(&content).map_err(|source| ParserError::InvalidYaml {
        path: path.display().to_string(),
        source,
    })
}

/// Walk from `start_path` up to root, merging any `perf.variable.yaml` /
/// `perf.variable.yml` files. Files closer to `start_path` override values
/// from files higher up the tree.
pub fn load_perf_variables_hierarchy(start_path: &Path) -> PerfVariables {
    let mut found = Vec::new();
    let mut current = start_path.to_path_buf();

    loop {
        for name in &["perf.variable.yaml", "perf.variable.yml"] {
            let p = current.join(name);
            if p.exists() {
                found.push(p);
            }
        }
        if !current.pop() {
            break;
        }
    }

    // Reverse so root comes first, allowing leafs to override.
    found.reverse();

    let mut merged = PerfVariables::new();
    for path in found {
        if let Ok(vars) = load_perf_variables(&path) {
            merged.extend(vars);
        }
    }
    merged
}

/// Substitute `{{key}}` placeholders inside `content` using `variables`.
pub fn substitute_perf_variables(content: &str, variables: &PerfVariables) -> String {
    if variables.is_empty() {
        return content.to_string();
    }
    let mut out = content.to_string();
    for (key, value) in variables {
        let placeholder = format!("{{{{{key}}}}}");
        let replacement = match value {
            serde_yaml::Value::String(s) => s.clone(),
            serde_yaml::Value::Number(n) => n.to_string(),
            serde_yaml::Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        out = out.replace(&placeholder, &replacement);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_simple_placeholders() {
        let mut vars = PerfVariables::new();
        vars.insert("users".into(), serde_yaml::Value::Number(10.into()));
        vars.insert("name".into(), serde_yaml::Value::String("hello".into()));
        let out = substitute_perf_variables("name={{name}} users={{users}}", &vars);
        assert_eq!(out, "name=hello users=10");
    }

    #[test]
    fn ignores_unknown_placeholders() {
        let vars = PerfVariables::new();
        assert_eq!(
            substitute_perf_variables("{{unknown}}", &vars),
            "{{unknown}}"
        );
    }
}
