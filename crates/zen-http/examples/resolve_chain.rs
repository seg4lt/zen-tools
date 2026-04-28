//! Diagnostic: resolve the full execution chain for every named request
//! across `examples/`. Useful for spotting cycles or missing deps.

use std::path::PathBuf;
use zen_http::{
    has_cross_file_dependencies, resolve_execution_order, CrossFileDependencyResolver,
    FileRegistry,
};
use zen_parser::parse_http_file;

fn main() {
    let registry = FileRegistry::new();
    let dir = PathBuf::from("examples");

    for entry in std::fs::read_dir(&dir).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().and_then(|s| s.to_str()) != Some("http") {
            continue;
        }
        let abs = p.canonicalize().unwrap();
        let content = std::fs::read_to_string(&abs).unwrap();
        let mut file = parse_http_file(&abs.display().to_string(), &content);
        for r in &mut file.requests {
            r.source_file = Some(abs.display().to_string());
        }
        registry.insert(abs.clone(), file.clone());

        println!("\n=== {} ===", file.filename);
        for r in &file.requests {
            let label = r.name.as_deref().unwrap_or("(anon)");
            if r.depends_on.is_empty() {
                println!("  {label:<25} (no deps)");
                continue;
            }

            if has_cross_file_dependencies(r) {
                let mut resolver = CrossFileDependencyResolver::new(&registry);
                match resolver.resolve(r) {
                    Ok(chain) => {
                        let order: Vec<_> =
                            chain.iter().map(|r| r.name.as_deref().unwrap_or("?")).collect();
                        println!("  {label:<25} → [{}]", order.join("  →  "));
                    }
                    Err(e) => println!("  {label:<25} ERR: {e}"),
                }
            } else {
                let target_name = r.name.clone().unwrap_or_default();
                match resolve_execution_order(&file.requests, &target_name) {
                    Ok(order) => {
                        println!("  {label:<25} → [{}]", order.join("  →  "));
                    }
                    Err(e) => println!("  {label:<25} ERR: {e}"),
                }
            }
        }
    }
}
