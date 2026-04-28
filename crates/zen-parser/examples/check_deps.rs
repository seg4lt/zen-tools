use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from("examples");
    for entry in std::fs::read_dir(&dir).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().and_then(|s| s.to_str()) == Some("http") {
            let content = std::fs::read_to_string(&p).unwrap();
            let f = zen_parser::parse_http_file(&p.display().to_string(), &content);
            println!("\n=== {} ({} requests, {} local vars) ===", f.filename, f.requests.len(), f.local_variables.len());
            for r in &f.requests {
                let name = r.name.as_deref().unwrap_or("(anon)");
                println!("  {} {} [line {}]", r.method, name, r.line_number);
                if !r.depends_on.is_empty() {
                    for d in &r.depends_on {
                        match d {
                            zen_types::request::DependencyRef::Local { name } =>
                                println!("    └─ depends LOCAL  {name}"),
                            zen_types::request::DependencyRef::CrossFile { file_path, request_name } =>
                                println!("    └─ depends CROSS  {file_path}:{request_name}"),
                        }
                    }
                }
                if !r.extract.is_empty() {
                    for (var, path) in &r.extract {
                        println!("    └─ extract {var} = {path}");
                    }
                }
                if !r.assertions.is_empty() {
                    for a in &r.assertions {
                        println!("    └─ assert  {a}");
                    }
                }
            }
        }
    }
}
