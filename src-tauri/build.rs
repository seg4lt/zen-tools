use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    // On macOS we link against a Swift-emitted dylib whose
    // install_name starts with `@rpath/`:
    //
    //   * `libzen_screen_vocab_bridge.dylib` (zen-screen-vocab)
    //
    // Cargo only honors `cargo:rustc-link-arg=...` for artifacts of
    // the package whose build script emitted it, so rpath link-args
    // declared in those crates' build.rs files get silently dropped
    // when the final binary is linked. We have to add them here, in
    // the binary's own build script, or the produced executable
    // ships with zero LC_RPATH entries and crashes at launch with
    // "no LC_RPATH's found".
    //
    // Both dylibs use the same set of rpaths, so a single block
    // covers both — the load-command count grows but the actual
    // search paths are shared.
    //
    // Layout we cover:
    //   * `cargo run` / `cargo tauri dev` → dylib sits next to the
    //     executable in `target/<profile>/` (the bridge crates'
    //     build.rs copies it there). `@executable_path/.` resolves
    //     it.
    //   * Bundled `.app`           → Tauri's bundler copies the dylib
    //     into `Contents/Frameworks/` (see `bundle.macOS.frameworks`
    //     in tauri.conf.json). `@executable_path/../Frameworks`
    //     resolves it from `Contents/MacOS/zen-tools`.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/.");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");

        // Pre-stage the Swift bridge dylibs at the static workspace
        // path that `tauri.conf.json`'s `bundle.macOS.frameworks`
        // references (`../target/release/lib*_bridge.dylib`).
        //
        // Why we do this here, in src-tauri's build.rs, rather than
        // in each bridge crate's own build.rs:
        //
        //   tauri_build::build() (called below) validates that every
        //   `frameworks` path exists and aborts the build with
        //   `Library not found` if not. That validation runs DURING
        //   src-tauri's compile. Cargo's build-script ordering only
        //   guarantees that THIS build.rs's [build-dependencies] are
        //   ready before it runs — regular dependencies like
        //   `zen-screen-vocab` may still be compiling, with their
        //   own build.rs's not yet started, when tauri_build runs.
        //   On a cold CI build that race bites and tauri_build fails
        //   even though the bridges *would* eventually copy the
        //   dylibs into place.
        //
        //   Solving this in src-tauri/build.rs (the one Cargo
        //   guarantees runs immediately before tauri_build) makes
        //   the staging deterministic. We invoke `swiftc` ourselves
        //   from the same source files the bridge crates use; the
        //   resulting dylibs are byte-equivalent and live at the
        //   stable workspace path. The bridge crates' build.rs
        //   continues to handle linking + `cargo run` ergonomics
        //   independently.
        prebuild_swift_bridges_for_bundle();
    }

    tauri_build::build()
}

/// One bridge: the swift source path (relative to workspace root)
/// and the resulting dylib filename.
struct Bridge {
    swift_relpath: &'static str,
    dylib_filename: &'static str,
    module_name: &'static str,
}

const BRIDGES: &[Bridge] = &[
    Bridge {
        swift_relpath: "crates/zen-screen-vocab/swift/ScreenVocabBridge.swift",
        dylib_filename: "libzen_screen_vocab_bridge.dylib",
        module_name: "ZenScreenVocabBridge",
    },
];

fn prebuild_swift_bridges_for_bundle() {
    // Same SDK gate as the bridge crates' build.rs — if Xcode 26+
    // isn't available we can't compile the swift sources anyway,
    // and the bridges fall back to their stubs at runtime. In that
    // case `bundle.macOS.frameworks` will reference dylibs that
    // don't exist; tauri_build will (correctly) error. Producing
    // a friendly diagnostic here is better than the cryptic
    // tauri_build message.
    let sdk_major = probe_sdk_major().unwrap_or(0);
    if sdk_major < 26 {
        // Don't panic — let tauri_build emit its native error so the
        // failure mode matches a fresh checkout's experience. We
        // print a hint though.
        println!(
            "cargo:warning=zen-tools build.rs: macOS SDK is {sdk_major} (< 26); \
             skipping Swift bridge pre-build. Tauri bundling will fail unless \
             you remove `bundle.macOS.frameworks` from tauri.conf.json."
        );
        return;
    }

    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"),
    );
    let workspace_root = manifest_dir
        .parent()
        .expect("src-tauri must have a parent (workspace root)")
        .to_path_buf();

    // Tauri's `bundle.macOS.frameworks` paths in tauri.conf.json are
    // `../target/release/lib*_bridge.dylib`, resolved relative to
    // `src-tauri/`. So the destination is always
    // `<workspace>/target/release/`, regardless of profile or
    // `--target` flag. Tauri build always uses release for the
    // bundling path; debug `cargo tauri dev` doesn't bundle, so it
    // doesn't trigger the framework validation we're solving here
    // (the bridges' next-to-binary copy handles dev runs).
    let dest_dir = workspace_root.join("target").join("release");
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        panic!(
            "zen-tools build.rs: failed to create {}: {e}",
            dest_dir.display()
        );
    }

    for bridge in BRIDGES {
        let swift_src = workspace_root.join(bridge.swift_relpath);
        let dest = dest_dir.join(bridge.dylib_filename);

        // `cargo:rerun-if-changed` so a swift edit triggers a
        // rebuild even when nothing in src-tauri changed.
        println!("cargo:rerun-if-changed={}", swift_src.display());

        // Skip when the dylib is already up-to-date (mtime ≥ swift
        // source). Saves ~10–20s per bridge on incremental builds.
        if is_dylib_up_to_date(&dest, &swift_src) {
            continue;
        }

        compile_bridge(&swift_src, &dest, bridge.module_name);
    }
}

fn probe_sdk_major() -> Option<u32> {
    let out = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-version"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    s.trim()
        .split('.')
        .next()
        .and_then(|seg| seg.parse::<u32>().ok())
}

fn is_dylib_up_to_date(dest: &Path, swift_src: &Path) -> bool {
    let (Ok(dest_meta), Ok(src_meta)) = (std::fs::metadata(dest), std::fs::metadata(swift_src))
    else {
        return false;
    };
    let (Ok(dest_mtime), Ok(src_mtime)) = (dest_meta.modified(), src_meta.modified()) else {
        return false;
    };
    dest_mtime >= src_mtime
}

fn compile_bridge(swift_src: &Path, dest: &Path, module_name: &str) {
    let install_name = format!(
        "@rpath/{}",
        dest.file_name()
            .and_then(|n| n.to_str())
            .expect("dest must have a UTF-8 filename")
    );

    // Mirror the swiftc invocation used in
    // `crates/zen-screen-vocab/build.rs` and
    // `crates/zen-screen-vocab/build.rs` — same flags, same output
    // shape. `xcrun swiftc` (not the resolved absolute path from
    // `xcrun -f swiftc`) is used so SDKROOT / DEVELOPER_DIR are
    // populated for the Xcode 26 SDK lookup.
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-emit-library",
            "-O",
            "-parse-as-library",
            "-module-name",
            module_name,
            "-Xlinker",
            "-install_name",
            "-Xlinker",
            &install_name,
            "-o",
        ])
        .arg(dest)
        .arg(swift_src)
        .status()
        .expect("zen-tools build.rs: failed to invoke `xcrun swiftc`");

    if !status.success() {
        panic!(
            "zen-tools build.rs: swiftc failed compiling {} → {} (status: {status:?}). \
             Check that Xcode 26+ is installed and selected via `xcode-select -p`.",
            swift_src.display(),
            dest.display()
        );
    }

    println!(
        "cargo:warning=zen-tools build.rs: pre-staged {} for tauri bundling",
        dest.display()
    );
}
