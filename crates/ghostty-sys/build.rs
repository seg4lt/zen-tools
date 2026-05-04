// build.rs — drives the zig build for libghostty.a, runs bindgen, emits
// link directives. macOS-only; the file no-ops on other targets so a
// hypothetical Linux port of the host crate still compiles (it just has
// no symbols to link).
//
// Inputs:
//   GHOSTTY_LIB_DIR (optional) — if set, skip the zig build and link from
//     this directory. Useful for CI caches and for re-running cargo
//     without paying the 3–8min Zig cold-build cost.
//   GHOSTTY_SDK_PATH (optional) — macOS SDK directory. If unset, the
//     build will rely on the wrapper xcrun shim from the workspace.
//   GHOSTTY_SKIP_PATCHES (optional) — if set to a truthy value, skip
//     applying patches/ghostty/*.patch. Useful when hacking inside
//     vendor/ghostty/ directly and managing patch state by hand.
//
// vendor/ghostty/ is a git submodule pinned to a clean upstream rev
// (e.g. v1.3.1). Our local build/SDK plumbing fixes live as ordered
// patch files under <workspace>/patches/ghostty/*.patch and are
// applied to the submodule working tree before invoking zig. The
// patch step is idempotent: it detects already-applied patches via
// `git apply -R --check` and no-ops in that case.
//
// We do all the heavy lifting in `build_libghostty()`, then point bindgen
// at `vendor/ghostty/include/ghostty.h` and write the generated bindings
// to `$OUT_DIR/bindings.rs`.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        // Other platforms: nothing to link, no bindings — keeps the crate
        // building on Linux/Windows so the dependent crates can `cfg!` it.
        // Emit an empty bindings module.
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        std::fs::write(out_dir.join("bindings.rs"), "// not macOS — no bindings\n")
            .expect("write empty bindings");
        return;
    }

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // crates/ghostty-sys → workspace root → vendor/ghostty
    let ghostty_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("vendor/ghostty"))
        .expect("workspace root");

    let lib_dir = if let Ok(dir) = std::env::var("GHOSTTY_LIB_DIR") {
        PathBuf::from(dir)
    } else {
        build_libghostty(&ghostty_root)
    };

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=ghostty");
    // libghostty pulls in CoreText (font), Metal (renderer), AppKit (window
    // glue), CoreGraphics (geometry), IOKit (display info), QuartzCore
    // (CALayer), Foundation. Order doesn't matter for frameworks.
    for fw in ["Metal", "MetalKit", "CoreText", "CoreGraphics", "AppKit",
               "IOKit", "IOSurface", "QuartzCore", "Foundation",
               "CoreFoundation", "CoreVideo", "Carbon", "OpenGL"] {
        println!("cargo:rustc-link-lib=framework={}", fw);
    }
    // libghostty embeds a bundled libc++ shim from Zig — match.
    println!("cargo:rustc-link-lib=c++");

    // Bindgen.
    let bindings = bindgen::Builder::default()
        .header(ghostty_root.join("include/ghostty.h").to_string_lossy())
        .clang_arg(format!("-I{}", ghostty_root.join("include").display()))
        // The `block` and `dispatch` headers from macOS SDK aren't needed.
        .layout_tests(false)
        .derive_default(true)
        .derive_debug(true)
        .generate_comments(true)
        // Allow the entire ghostty_* namespace.
        .allowlist_function("ghostty_.*")
        .allowlist_type("ghostty_.*")
        .allowlist_var("GHOSTTY_.*")
        .generate()
        .expect("bindgen failed");

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out.join("bindings.rs"))
        .expect("write bindings");

    // Re-run when these change. Don't watch vendor/ghostty/vendor (zig
    // package cache) — that triggers spurious rebuilds.
    println!("cargo:rerun-if-changed={}", ghostty_root.join("include").display());
    println!("cargo:rerun-if-changed={}", ghostty_root.join("src").display());
    println!("cargo:rerun-if-changed={}", ghostty_root.join("build.zig").display());
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=GHOSTTY_LIB_DIR");
    println!("cargo:rerun-if-env-changed=GHOSTTY_SDK_PATH");
}

/// Invoke `zig build install` against `vendor/ghostty/build.zig` and
/// return the directory containing `libghostty.a`. Honors the wrapper
/// xcrun shim by prepending `tools/ghostty-xcrun-shim` (workspace-local)
/// to PATH. Falls back to `/tmp/ghostty-xcrun-shim` if the shim has been
/// installed there during development.
fn build_libghostty(ghostty_root: &std::path::Path) -> PathBuf {
    apply_patches(ghostty_root);

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let install_dir = out_dir.join("ghostty-install");

    // Resolve zig binary. Prefer $ZIG > mise > which zig.
    let zig = std::env::var("ZIG").unwrap_or_else(|_| {
        let try_mise = Command::new("mise")
            .args(["which", "zig"])
            .output()
            .ok()
            .and_then(|o| if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            });
        try_mise.unwrap_or_else(|| "zig".to_string())
    });

    // Locate the xcrun shim. The shim lives at workspace-root
    // `tools/ghostty-xcrun-shim/xcrun`. From `crates/ghostty-sys/`'s
    // perspective: ghostty_root = WORKSPACE/vendor/ghostty, so we
    // need TWO `parent()` hops to reach the workspace root before
    // joining `tools/...` (the previous code did one hop and looked
    // under `vendor/tools/...`, which never existed — locally that
    // silently fell back to `/tmp/ghostty-xcrun-shim` from a prior
    // dev session, but on a fresh CI runner the fallback is missing
    // and `xcrun metal` ends up running against /usr/bin/xcrun under
    // the CLT toolchain that has no metal compiler → build failure).
    let workspace_shim = ghostty_root
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("tools/ghostty-xcrun-shim"));
    let tmp_shim = PathBuf::from("/tmp/ghostty-xcrun-shim");
    let shim_dir = workspace_shim
        .filter(|p| p.exists())
        .unwrap_or(tmp_shim);

    // SDK + DEVELOPER_DIR resolution. Three branches:
    //
    //   1. `GHOSTTY_SDK_PATH` set explicitly → use it (and set
    //      DEVELOPER_DIR to CLT so `xcrun --show-sdk-path` doesn't
    //      surprise us with a different default).
    //   2. CLT MacOSX15.sdk exists locally → use it (this is the
    //      normal local-dev path on macOS-26+ hosts where Zig 0.15.2
    //      can't parse the host SDK's libSystem.tbd).
    //   3. Neither → leave DEVELOPER_DIR / SDKROOT inherited from the
    //      environment (typical CI runner with full Xcode 14/15.x —
    //      Zig + the metal compiler resolve via `xcrun` against the
    //      runner's pre-selected Xcode without overrides).
    let env_sdk = std::env::var("GHOSTTY_SDK_PATH").ok();
    let clt_sdk = "/Library/Developer/CommandLineTools/SDKs/MacOSX15.sdk";
    let clt_sdk_exists = std::path::Path::new(clt_sdk).exists();
    let (sdk_path, override_developer_dir) = if let Some(ref s) = env_sdk {
        (Some(s.clone()), true)
    } else if clt_sdk_exists {
        (Some(clt_sdk.to_string()), true)
    } else {
        (None, false)
    };

    // Compose PATH with the shim first.
    let cur_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", shim_dir.display(), cur_path);

    let mut cmd = Command::new(&zig);
    cmd.current_dir(ghostty_root)
        .args([
            "build", "install",
            "-Dapp-runtime=none",
            "-Drenderer=metal",
            "-Dfont-backend=coretext",
            "-Demit-xcframework=false",
            "-Doptimize=ReleaseFast",
            "--prefix",
        ])
        .arg(&install_dir)
        .env("PATH", &new_path);

    if let Some(ref sdk) = sdk_path {
        cmd.env("GHOSTTY_SDK_PATH", sdk).env("SDKROOT", sdk);
    }
    if override_developer_dir {
        cmd.env("DEVELOPER_DIR", "/Library/Developer/CommandLineTools");
    }

    let status = cmd.status().expect("invoke zig build");

    if !status.success() {
        panic!(
            "zig build failed (status {:?}). \
             Set GHOSTTY_LIB_DIR to a prebuilt libghostty.a directory to skip the build.",
            status.code()
        );
    }

    install_dir.join("lib")
}

/// Apply every `<workspace>/patches/ghostty/*.patch` to the
/// `vendor/ghostty` working tree, in lexicographic order.
///
/// Idempotent: for each patch we first ask `git apply -R --check` whether
/// it's already in the tree; if so, skip. Otherwise we ask `git apply
/// --check` whether it would apply cleanly forward; if so, apply. If
/// neither check succeeds the submodule rev has drifted away from what
/// the patch was generated against — panic with a clear hint so the
/// human bumps the patch instead of getting a confusing zig build error
/// later.
///
/// Skipped entirely when `GHOSTTY_SKIP_PATCHES` is set (for in-place
/// hacking inside vendor/ghostty/).
fn apply_patches(ghostty_root: &std::path::Path) {
    if env_truthy("GHOSTTY_SKIP_PATCHES") {
        println!(
            "cargo:warning=GHOSTTY_SKIP_PATCHES set — not applying patches/ghostty/*.patch"
        );
        println!("cargo:rerun-if-env-changed=GHOSTTY_SKIP_PATCHES");
        return;
    }
    println!("cargo:rerun-if-env-changed=GHOSTTY_SKIP_PATCHES");

    let workspace_root = ghostty_root
        .parent()
        .and_then(|p| p.parent())
        .expect("workspace root from vendor/ghostty");
    let patches_dir = workspace_root.join("patches/ghostty");

    if !patches_dir.is_dir() {
        // No patches directory — nothing to do, not an error.
        return;
    }

    // Watch the directory itself so adding a new patch file triggers
    // re-run. (Cargo watches mtime of the dir entry list.)
    println!("cargo:rerun-if-changed={}", patches_dir.display());

    let mut patches: Vec<PathBuf> = std::fs::read_dir(&patches_dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", patches_dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("patch"))
        .collect();
    patches.sort();

    for patch in &patches {
        // Per-file rerun watch.
        println!("cargo:rerun-if-changed={}", patch.display());

        // Already applied? `git apply -R --check` exits 0 iff the
        // forward patch is reversible against the current tree, which
        // is exactly the "already applied" condition.
        let reverse_check = Command::new("git")
            .current_dir(ghostty_root)
            .args(["apply", "-R", "--check"])
            .arg(patch)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if matches!(reverse_check, Ok(s) if s.success()) {
            // Already in the tree — quiet skip.
            continue;
        }

        // Can apply forward?
        let fwd_check = Command::new("git")
            .current_dir(ghostty_root)
            .args(["apply", "--check"])
            .arg(patch)
            .status()
            .expect("invoke git apply --check");
        if !fwd_check.success() {
            panic!(
                "patch {} does not apply cleanly to the current vendor/ghostty checkout, \
                 and is not already applied. The submodule rev likely drifted away from \
                 what this patch was generated against. Either bump vendor/ghostty back to \
                 a compatible rev, or regenerate the patch (cd vendor/ghostty && \
                 git format-patch <base>..HEAD -o ../../patches/ghostty/). \
                 Set GHOSTTY_SKIP_PATCHES=1 to suppress patch application entirely.",
                patch.display(),
            );
        }

        let apply = Command::new("git")
            .current_dir(ghostty_root)
            .args(["apply"])
            .arg(patch)
            .status()
            .expect("invoke git apply");
        if !apply.success() {
            panic!(
                "git apply {} failed (status {:?}) after a successful --check; \
                 vendor/ghostty may now be in a partially-patched state — \
                 reset with `git -C vendor/ghostty checkout -- .`",
                patch.display(),
                apply.code(),
            );
        }
        println!("cargo:warning=applied patch {}", patch.display());
    }
}

fn env_truthy(name: &str) -> bool {
    matches!(
        std::env::var(name).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES") | Ok("on") | Ok("ON")
    )
}
