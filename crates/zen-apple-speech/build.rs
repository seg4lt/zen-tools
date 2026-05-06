//! Build script — compiles `swift/AppleSpeechBridge.swift` into a
//! dynamic library and tells cargo where to find it.
//!
//! Workflow:
//!
//! 1. Skip on non-macOS (the Rust crate has stubs for that case).
//! 2. Probe `xcrun --sdk macosx --show-sdk-version`. If the SDK is
//!    older than 26.0 we also skip — `SpeechAnalyzer` / `AssetInventory`
//!    weren't shipped before macOS 26 and the Swift sources won't
//!    compile against an older SDK. The Rust side detects this via the
//!    `apple_speech_compiled` cfg flag we set below.
//! 3. Otherwise, run `swiftc -emit-library -O` to produce
//!    `libzen_apple_speech_bridge.dylib` in `OUT_DIR`, link against it,
//!    and emit the rerun-if-changed pragmas.
//!
//! Notes:
//!
//! * We emit a *dynamic* library (not a static archive) because Swift
//!   has no `-static-stdlib`-equivalent that's guaranteed to work
//!   across Xcode versions, and pulling individual `.swiftmodule`
//!   archives into a static `.a` requires hand-rolled linker glue
//!   that's much more brittle than just letting `swiftc` produce a
//!   self-contained dylib.
//! * For dev runs (`cargo run`, `cargo tauri dev`) the dylib lives in
//!   `target/<profile>/build/.../out/`. We add an `@rpath` pointing at
//!   `$ORIGIN`-equivalent so the binary can find it relative to its
//!   own location once we copy it next to the executable in
//!   `target/<profile>/`.
//! * For production bundles the Tauri bundler needs to copy the dylib
//!   into `Contents/Frameworks/` of the .app — that wiring lives in
//!   `src-tauri/tauri.conf.json` (see the `bundle.macOS.frameworks`
//!   key) and is set up alongside this PR.

use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // Declare every cfg name we may emit so rustc's `check-cfg` lint
    // (Rust 1.80+) doesn't warn about an "unknown cfg".
    println!("cargo:rustc-check-cfg=cfg(apple_speech_compiled)");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        // Non-macOS builds: nothing to compile, the Rust stub takes
        // over and reports `Unavailable` from every entry point.
        println!("cargo:rerun-if-changed=build.rs");
        return;
    }

    // The Swift source itself is small; rerun whenever it changes.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=swift/AppleSpeechBridge.swift");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=ZEN_APPLE_SPEECH_FORCE_STUB");

    // Escape hatch for environments where we want to explicitly
    // force the stub path — useful in CI before macOS 26 runners are
    // available.
    if env::var("ZEN_APPLE_SPEECH_FORCE_STUB").is_ok() {
        eprintln!("zen-apple-speech: ZEN_APPLE_SPEECH_FORCE_STUB set; emitting stub");
        return;
    }

    // Detect the SDK version. `xcrun --sdk macosx --show-sdk-version`
    // returns something like `26.0` on a Tahoe-era Xcode.
    let sdk_version = match probe_sdk_version() {
        Some(v) => v,
        None => {
            eprintln!(
                "zen-apple-speech: could not probe macosx SDK version; falling back to stub"
            );
            return;
        }
    };

    // Parse the major version. SemVer-shaped (`26`, `26.0`, `26.1`).
    let major: u32 = sdk_version
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if major < 26 {
        eprintln!(
            "zen-apple-speech: macosx SDK is {sdk_version} (< 26); SpeechAnalyzer is not available, emitting stub"
        );
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let dylib_path = out_dir.join("libzen_apple_speech_bridge.dylib");
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let swift_src = manifest_dir.join("swift").join("AppleSpeechBridge.swift");

    // We invoke swiftc via `xcrun swiftc ...` (not the resolved
    // absolute path from `xcrun -f swiftc`). xcrun also exports the
    // `SDKROOT` / `DEVELOPER_DIR` environment swiftc needs to locate
    // the macOS SDK and Swift stdlib; calling the resolved path
    // directly fails with
    //   "unable to load standard library for target arm64-apple-macosx26.0"
    // on Xcode 26 because swiftc defaults to the host triple but
    // can't find a matching stdlib without `SDKROOT` pointing at the
    // installed SDK.
    //
    // We deliberately do NOT pass `-target` — runtime availability
    // checks (`@available(macOS 26.0, *)`) in the Swift source are
    // what gate the API calls. Older OS users see
    // `apple_speech_is_supported() == 0` and fall back to Whisper.
    let _ = major;

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-emit-library",
            "-O",
            "-parse-as-library",
            "-module-name",
            "ZenAppleSpeechBridge",
            "-Xlinker",
            "-install_name",
            "-Xlinker",
            "@rpath/libzen_apple_speech_bridge.dylib",
            "-o",
        ])
        .arg(&dylib_path)
        .arg(&swift_src)
        .status()
        .expect("failed to invoke xcrun swiftc");

    if !status.success() {
        panic!(
            "swiftc failed compiling the Apple Speech bridge (status: {status:?}). \
             Check that Xcode 26+ is installed and selected via `xcode-select`."
        );
    }

    // Tell cargo to link against the produced dylib and add the OUT_DIR
    // to rpath so `cargo run` finds it without bundling.
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=dylib=zen_apple_speech_bridge");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", out_dir.display());
    // Also add @executable_path-relative rpaths so the produced binary
    // can find the dylib next to itself (dev) or in a Frameworks dir
    // (bundled .app).
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/.");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");

    // Cfg flag the Rust side reads to decide between the real impl and
    // the stub. This is the single source of truth.
    println!("cargo:rustc-cfg=apple_speech_compiled");

    // Copy the dylib to two places:
    //
    //   1. **Next to the eventual binary** (`<workspace>/target[/<triple>]/<profile>/`)
    //      so plain `cargo run` finds it via the `@executable_path/.`
    //      rpath. This is `OUT_DIR.parent^3`.
    //
    //   2. **`<workspace>/target/<profile>/`** (always, no triple
    //      segment) so `src-tauri/tauri.conf.json`'s static
    //      `../target/release/lib*.dylib` reference resolves
    //      regardless of whether the build was invoked with
    //      `--target <triple>`. CI builds with `--target
    //      aarch64-apple-darwin`, which puts artifacts under
    //      `target/aarch64-apple-darwin/release/`; without this
    //      second copy the Tauri bundler errors with
    //      `Library not found: ../target/release/lib*.dylib`.
    //
    // Be defensive: if the layout shifts (workspace override, custom
    // target dir, etc.) we just skip the copies and rely on the
    // OUT_DIR-rpath above.
    if let Ok(profile) = env::var("PROFILE") {
        let dylib_filename = "libzen_apple_speech_bridge.dylib";

        // (1) Next to binary — OUT_DIR.parent^3.
        if let Some(exec_dir) = next_to_binary_dir(&out_dir) {
            let dest = exec_dir.join(dylib_filename);
            if let Err(e) = std::fs::copy(&dylib_path, &dest) {
                eprintln!(
                    "zen-apple-speech: warning — failed to copy dylib to {}: {e}",
                    dest.display()
                );
            }
        }

        // (2) Stable workspace path for tauri.conf.json.
        if let Some(workspace_target) = locate_workspace_target_dir(&out_dir) {
            let stable_dest = workspace_target.join(&profile).join(dylib_filename);
            // The next-to-binary copy above may already have
            // written here in the no-triple case — `fs::copy` is
            // idempotent, no harm.
            if let Some(parent) = stable_dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::copy(&dylib_path, &stable_dest) {
                eprintln!(
                    "zen-apple-speech: warning — failed to copy dylib to stable workspace path {}: {e}",
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
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// The `<workspace>/target/[<triple>/]<profile>/` directory the
/// final binary will be written to — i.e. where `@executable_path/.`
/// resolves to at runtime. OUT_DIR is `<that>/build/<crate>-<hash>/out`,
/// so this is `OUT_DIR.parent^3`. Used for the "next to the binary"
/// dylib copy.
fn next_to_binary_dir(out_dir: &PathBuf) -> Option<PathBuf> {
    out_dir
        .parent() // .../build/<crate>/
        .and_then(|p| p.parent()) // .../build/
        .and_then(|p| p.parent()) // .../<profile>/  (or .../<triple>/<profile>/)
        .map(|p| p.to_path_buf())
}

/// Walk up from OUT_DIR until we find an ancestor named `target/`.
/// Handles both layouts:
///
///   * No `--target`:  OUT_DIR = `<ws>/target/<profile>/build/<crate>/out`
///                     → walk 4 levels → `<ws>/target/`
///   * With `--target`: OUT_DIR = `<ws>/target/<triple>/<profile>/build/<crate>/out`
///                     → walk 5 levels → `<ws>/target/`
///
/// Returns `<ws>/target/` in both cases. Caller appends `<profile>/`
/// to land at the stable workspace-relative bundle path
/// `tauri.conf.json` expects.
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
