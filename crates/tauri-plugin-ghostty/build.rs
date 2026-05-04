// build.rs — registers Tauri permissions + compiles the ObjC host view
// into a static archive that we link against.

const COMMANDS: &[&str] = &[
    "terminal_new",
    "terminal_set_color_scheme",
    "terminal_split",
    "terminal_focus_split",
];

fn main() {
    // Generate the Tauri permissions/scopes manifest. Without this, the
    // commands aren't callable from JS.
    tauri_plugin::Builder::new(COMMANDS).build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    println!("cargo:rerun-if-changed=src/GhosttyHostView.m");
    println!("cargo:rerun-if-changed=src/GhosttyHostView.h");

    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let ghostty_include = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("vendor/ghostty/include"))
        .expect("workspace root");

    cc::Build::new()
        .file("src/GhosttyHostView.m")
        .include(&ghostty_include)
        .flag("-fobjc-arc")
        .flag("-fmodules")
        .flag_if_supported("-Wno-unused-parameter")
        .compile("ghostty_host_view");

    // Frameworks the host view itself uses (ghostty-sys already links the
    // bigger set, but cc-built objects still need their own declarations).
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=QuartzCore");
}
