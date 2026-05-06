//! Build script — compiles `swift/ScreenVocabBridge.swift` into a
//! dynamic library and tells cargo where to find it.
//!
//! Identical pattern to `crates/zen-apple-speech/build.rs`: we probe
//! the macOS SDK via `xcrun --sdk macosx --show-sdk-version`, skip on
//! non-macOS or SDK < 26 (ScreenCaptureKit + the modern `Vision`
//! `VNRecognizeTextRequest` shape we use both predate macOS 26 by a
//! lot, but we keep the same gate as Apple Speech because the rest of
//! the dictation feature only matters when the speech bridge also
//! built — and it lets us share the same `@rpath` wiring already in
//! `src-tauri/build.rs`).
//!
//! The Rust side reads the `screen_vocab_compiled` cfg flag we set on
//! success to decide between the real impl and a stub that returns an
//! empty `Vec<String>`.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(screen_vocab_compiled)");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        println!("cargo:rerun-if-changed=build.rs");
        return;
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=swift/ScreenVocabBridge.swift");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=ZEN_SCREEN_VOCAB_FORCE_STUB");

    if env::var("ZEN_SCREEN_VOCAB_FORCE_STUB").is_ok() {
        eprintln!("zen-screen-vocab: ZEN_SCREEN_VOCAB_FORCE_STUB set; emitting stub");
        return;
    }

    let sdk_version = match probe_sdk_version() {
        Some(v) => v,
        None => {
            eprintln!(
                "zen-screen-vocab: could not probe macosx SDK version; falling back to stub"
            );
            return;
        }
    };

    let major: u32 = sdk_version
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if major < 26 {
        eprintln!(
            "zen-screen-vocab: macosx SDK is {sdk_version} (< 26); emitting stub"
        );
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let dylib_path = out_dir.join("libzen_screen_vocab_bridge.dylib");
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let swift_src = manifest_dir.join("swift").join("ScreenVocabBridge.swift");

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-emit-library",
            "-O",
            "-parse-as-library",
            "-module-name",
            "ZenScreenVocabBridge",
            "-Xlinker",
            "-install_name",
            "-Xlinker",
            "@rpath/libzen_screen_vocab_bridge.dylib",
            "-o",
        ])
        .arg(&dylib_path)
        .arg(&swift_src)
        .status()
        .expect("failed to invoke xcrun swiftc");

    if !status.success() {
        panic!(
            "swiftc failed compiling the Screen Vocab bridge (status: {status:?}). \
             Check that Xcode 26+ is installed and selected via `xcode-select`."
        );
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=dylib=zen_screen_vocab_bridge");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", out_dir.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/.");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");

    println!("cargo:rustc-cfg=screen_vocab_compiled");

    // Copy the dylib to two places — same scheme as zen-apple-speech:
    //
    //   1. Next to the eventual binary (resolved from OUT_DIR^3) so
    //      `cargo run` finds it via `@executable_path/.`.
    //   2. `<workspace>/target/<profile>/` (always, no triple) so
    //      `tauri.conf.json`'s static `../target/release/lib*.dylib`
    //      resolves regardless of `--target` flag. CI builds with
    //      `--target aarch64-apple-darwin` and the bundler errors
    //      with `Library not found` if this stable copy is missing.
    if let Ok(profile) = env::var("PROFILE") {
        let dylib_filename = "libzen_screen_vocab_bridge.dylib";

        // (1) Next to binary.
        if let Some(exec_dir) = next_to_binary_dir(&out_dir) {
            let dest = exec_dir.join(dylib_filename);
            if let Err(e) = std::fs::copy(&dylib_path, &dest) {
                eprintln!(
                    "zen-screen-vocab: warning — failed to copy dylib to {}: {e}",
                    dest.display()
                );
            }
        }

        // (2) Stable workspace path for tauri.conf.json.
        if let Some(workspace_target) = locate_workspace_target_dir(&out_dir) {
            let stable_dest = workspace_target.join(&profile).join(dylib_filename);
            if let Some(parent) = stable_dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::copy(&dylib_path, &stable_dest) {
                eprintln!(
                    "zen-screen-vocab: warning — failed to copy dylib to stable workspace path {}: {e}",
                    stable_dest.display()
                );
            }
        }
    }
}

fn probe_sdk_version() -> Option<String> {
    let out = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-version"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let v = s.trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

/// Where the final binary will sit (`OUT_DIR.parent^3`). Same shape
/// as the helper in `crates/zen-apple-speech/build.rs` — kept
/// duplicated rather than factored into a tiny shared crate so each
/// build script stays self-contained (build-time deps cost cold-build
/// minutes more than they're worth here).
fn next_to_binary_dir(out_dir: &PathBuf) -> Option<PathBuf> {
    out_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
}

/// Walks up from OUT_DIR until it finds an ancestor named `target/`.
/// Handles both no-`--target` (4 levels) and `--target <triple>`
/// (5 levels) layouts. Returns the workspace's `target/` so callers
/// can land at the stable bundle path the Tauri config expects.
fn locate_workspace_target_dir(out_dir: &PathBuf) -> Option<PathBuf> {
    let mut p = out_dir.as_path();
    for _ in 0..8 {
        let parent = p.parent()?;
        if parent.file_name().map(|n| n == "target").unwrap_or(false) {
            return Some(parent.to_path_buf());
        }
        p = parent;
    }
    None
}
