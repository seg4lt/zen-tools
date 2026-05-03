//! Build whisper.cpp from the vendored sources and generate Rust bindings.
//!
//! Pinned upstream: ggerganov/whisper.cpp v1.7.4 (commit e8731e5).
//!
//! Strategy:
//!
//! * **macOS (any arch)** — compile the C/C++ + Objective-C Metal
//!   backend, embed the Metal shader library inline (so we don't have
//!   to ship a `default.metallib` next to the binary), link against
//!   Metal / MetalKit / Foundation / Accelerate, then run `bindgen`
//!   against `whisper.h`.
//! * **Other platforms** — do nothing. `lib.rs` `#[cfg]`-gates the
//!   `mod sys` so `WhisperContext::load` returns `NotSupported`. This
//!   keeps the workspace `cargo check`-able everywhere while we focus
//!   on macOS for v1; CPU / CUDA / Vulkan backends can be added by
//!   extending this file.
//!
//! ## Metal embedding
//!
//! Upstream's CMake glues `ggml-common.h` + `ggml-metal-impl.h` into
//! `ggml-metal.metal`, then writes an assembly file using `.incbin`
//! to expose the resulting source as `_ggml_metallib_start` /
//! `_ggml_metallib_end`. We replicate that in pure Rust here so the
//! crate has no external dependency on `xcrun` at build time.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest_dir.join("vendor").join("whisper.cpp");

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", vendor.display());

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        // Stub builds on non-macOS targets — `lib.rs` exposes a
        // `WhisperContext` whose methods return `NotSupported`, so
        // there's no FFI to link and nothing for `bindgen` to chew on.
        println!(
            "cargo:warning=zen-whisper: target_os={target_os} — skipping native build (mac-only for now)"
        );
        return;
    }

    build_macos(&vendor);
    generate_bindings(&vendor);
}

fn build_macos(vendor: &Path) {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let ggml_inc = vendor.join("ggml").join("include");
    let ggml_src = vendor.join("ggml").join("src");
    let cpu_dir = ggml_src.join("ggml-cpu");
    let metal_dir = ggml_src.join("ggml-metal");
    let whisper_inc = vendor.join("include");
    let whisper_src = vendor.join("src").join("whisper.cpp");

    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let is_arm64 = target_arch == "aarch64";

    // Force the macOS deployment target to **11.0**.
    //
    // ggml-backend-reg.cpp uses `std::filesystem` (introduced 10.15).
    // Tauri's release-bundle default deployment target is 10.13, which
    // makes `cc-rs` pick `-mmacosx-version-min=10.13` and the build
    // fails with "exists is unavailable: introduced in macOS 10.15".
    //
    // 11.0 is the minimum macOS that runs Apple Silicon natively, and
    // any Intel Mac shipping with ≥10.15 (i.e. ≥2019) is still in
    // support. Setting via env var here means cc-rs picks it up for
    // every translation unit we compile from this crate, regardless
    // of what Tauri / cargo configured at the workspace level. We
    // also surface it in `tauri.conf.json` (`bundle.macOS.minimumSystemVersion`)
    // so the bundled `LSMinimumSystemVersion` agrees with the binary.
    if env::var_os("MACOSX_DEPLOYMENT_TARGET").is_none() {
        // SAFETY: build.rs runs single-threaded.
        std::env::set_var("MACOSX_DEPLOYMENT_TARGET", "11.0");
    }
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");

    // ── 1. Generate the embedded-Metal assembly file ───────────────────
    let embed_asm = generate_metal_embed_asm(vendor, &out_dir);

    // ── 2. Common flags ────────────────────────────────────────────────
    let common_includes: Vec<&Path> = vec![
        whisper_inc.as_path(),
        ggml_inc.as_path(),
        ggml_src.as_path(),
        cpu_dir.as_path(),
    ];

    let common_defines = [
        ("GGML_USE_CPU", "1"),
        ("GGML_USE_METAL", "1"),
        ("GGML_USE_ACCELERATE", "1"),
        ("ACCELERATE_NEW_LAPACK", "1"),
        ("ACCELERATE_LAPACK_ILP64", "1"),
        ("GGML_METAL_EMBED_LIBRARY", "1"),
        ("_DARWIN_C_SOURCE", "1"),
    ];

    // ── 3. C compile unit (ggml core + cpu C-only files) ──────────────
    let mut cc_c = cc::Build::new();
    cc_c.std("c11");
    for inc in &common_includes {
        cc_c.include(inc);
    }
    for (k, v) in &common_defines {
        cc_c.define(k, *v);
    }
    cc_c.flag_if_supported("-O3");
    cc_c.flag_if_supported("-fPIC");
    cc_c.flag_if_supported("-pthread");
    cc_c.flag_if_supported("-Wno-unused-function");
    cc_c.flag_if_supported("-Wno-unused-variable");
    cc_c.flag_if_supported("-Wno-deprecated-declarations");
    cc_c.flag_if_supported("-Wno-unused-but-set-variable");
    if is_arm64 {
        // Apple Silicon: NEON/dotprod/fp16/i8mm are all baseline since M1.
        cc_c.flag_if_supported("-mcpu=apple-m1");
    }
    cc_c.files([
        ggml_src.join("ggml.c"),
        ggml_src.join("ggml-alloc.c"),
        ggml_src.join("ggml-quants.c"),
        cpu_dir.join("ggml-cpu.c"),
        cpu_dir.join("ggml-cpu-quants.c"),
    ]);
    cc_c.compile("ggml_c");

    // ── 4. C++ compile unit (whisper + ggml C++ glue + cpu C++) ───────
    let mut cc_cxx = cc::Build::new();
    cc_cxx.cpp(true);
    cc_cxx.std("c++17");
    for inc in &common_includes {
        cc_cxx.include(inc);
    }
    for (k, v) in &common_defines {
        cc_cxx.define(k, *v);
    }
    cc_cxx.flag_if_supported("-O3");
    cc_cxx.flag_if_supported("-fPIC");
    cc_cxx.flag_if_supported("-pthread");
    cc_cxx.flag_if_supported("-Wno-unused-function");
    cc_cxx.flag_if_supported("-Wno-unused-variable");
    cc_cxx.flag_if_supported("-Wno-deprecated-declarations");
    cc_cxx.flag_if_supported("-Wno-multichar");
    if is_arm64 {
        cc_cxx.flag_if_supported("-mcpu=apple-m1");
    }
    cc_cxx.files([
        whisper_src.clone(),
        ggml_src.join("ggml-backend.cpp"),
        ggml_src.join("ggml-backend-reg.cpp"),
        ggml_src.join("ggml-threading.cpp"),
        ggml_src.join("ggml-opt.cpp"),
        cpu_dir.join("ggml-cpu.cpp"),
        cpu_dir.join("ggml-cpu-aarch64.cpp"),
        cpu_dir.join("ggml-cpu-hbm.cpp"),
        cpu_dir.join("ggml-cpu-traits.cpp"),
    ]);
    cc_cxx.compile("whisper_cpp");

    // ── 5. Objective-C Metal backend ──────────────────────────────────
    let mut cc_m = cc::Build::new();
    for inc in &common_includes {
        cc_m.include(inc);
    }
    cc_m.include(&metal_dir);
    for (k, v) in &common_defines {
        cc_m.define(k, *v);
    }
    // Upstream's ggml-metal.m uses MRC explicitly (`[obj release]`,
    // bare casts to `void *`). Enabling ARC produces ~30 errors. Stay
    // on MRC to match the upstream CMake setup.
    cc_m.flag("-fno-objc-arc");
    cc_m.flag_if_supported("-O3");
    cc_m.flag_if_supported("-Wno-deprecated-declarations");
    cc_m.flag_if_supported("-Wno-unused-variable");
    cc_m.flag_if_supported("-Wno-unused-function");
    if is_arm64 {
        cc_m.flag_if_supported("-mcpu=apple-m1");
    }
    cc_m.file(metal_dir.join("ggml-metal.m"));
    cc_m.compile("ggml_metal");

    // ── 6. Embedded Metal library (assembly) ──────────────────────────
    let mut cc_asm = cc::Build::new();
    cc_asm.file(&embed_asm);
    cc_asm.compile("ggml_metal_embed");

    // ── 7. Frameworks ─────────────────────────────────────────────────
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=MetalKit");
    println!("cargo:rustc-link-lib=framework=Accelerate");
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
    println!("cargo:rustc-link-lib=c++");
}

/// Build the embedded-Metal `.s` file. Mirrors the bash/sed dance the
/// upstream CMakeLists does — see the comments in
/// `ggml/src/ggml-metal/CMakeLists.txt` for the original shape.
fn generate_metal_embed_asm(vendor: &Path, out_dir: &Path) -> PathBuf {
    let metal_dir = vendor.join("ggml").join("src").join("ggml-metal");
    let common_h = vendor.join("ggml").join("src").join("ggml-common.h");
    let metal_src = metal_dir.join("ggml-metal.metal");
    let metal_impl = metal_dir.join("ggml-metal-impl.h");

    let metal_text = fs::read_to_string(&metal_src)
        .unwrap_or_else(|e| panic!("read {}: {e}", metal_src.display()));
    let common_text = fs::read_to_string(&common_h)
        .unwrap_or_else(|e| panic!("read {}: {e}", common_h.display()));
    let impl_text = fs::read_to_string(&metal_impl)
        .unwrap_or_else(|e| panic!("read {}: {e}", metal_impl.display()));

    // 1. Inline ggml-common.h at the `__embed_ggml-common.h__` marker.
    // 2. Inline ggml-metal-impl.h at the `#include "ggml-metal-impl.h"`
    //    line. Both substitutions are identical to the upstream sed
    //    invocation — we keep the same sentinels so future diffs
    //    against upstream are obvious.
    let mut embedded = String::with_capacity(metal_text.len() + common_text.len() + impl_text.len());
    let mut substituted_common = false;
    let mut substituted_impl = false;
    for line in metal_text.lines() {
        let trimmed = line.trim();
        if trimmed.contains("__embed_ggml-common.h__") {
            embedded.push_str(&common_text);
            embedded.push('\n');
            substituted_common = true;
            continue;
        }
        if trimmed == "#include \"ggml-metal-impl.h\"" {
            embedded.push_str(&impl_text);
            embedded.push('\n');
            substituted_impl = true;
            continue;
        }
        embedded.push_str(line);
        embedded.push('\n');
    }
    if !substituted_common {
        panic!("metal embed: marker '__embed_ggml-common.h__' not found in ggml-metal.metal");
    }
    if !substituted_impl {
        panic!("metal embed: include line for ggml-metal-impl.h not found in ggml-metal.metal");
    }

    let embedded_metal_path = out_dir.join("ggml-metal-embed.metal");
    fs::write(&embedded_metal_path, embedded).expect("write embedded metal");

    // Generate the assembly file that hosts the embedded blob and
    // exposes the `ggml_metallib_start` / `ggml_metallib_end` symbols
    // the Obj-C side declares as `extern const char[]`. The leading
    // underscore in the symbol names is the Mach-O convention (the C
    // identifier `ggml_metallib_start` becomes the asm symbol
    // `_ggml_metallib_start`).
    let asm_path = out_dir.join("ggml-metal-embed.s");
    let asm = format!(
        ".section __DATA,__ggml_metallib\n\
         .globl _ggml_metallib_start\n\
         _ggml_metallib_start:\n\
         .incbin \"{}\"\n\
         .globl _ggml_metallib_end\n\
         _ggml_metallib_end:\n",
        embedded_metal_path.display()
    );
    fs::write(&asm_path, asm).expect("write embed asm");
    asm_path
}

/// Run `bindgen` against `whisper.h` and emit `whisper_bindings.rs`.
fn generate_bindings(vendor: &Path) {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let header = vendor.join("include").join("whisper.h");

    let bindings = bindgen::Builder::default()
        .header(header.to_string_lossy())
        .clang_arg(format!("-I{}", vendor.join("include").display()))
        .clang_arg(format!(
            "-I{}",
            vendor.join("ggml").join("include").display()
        ))
        // Allowlist whisper's surface only; leave the ggml innards on
        // the C side. Without this the generated file balloons to
        // thousands of unused ggml lines. We do allow a couple of
        // ggml typedefs through because whisper.h refers to them in
        // its public function pointer signatures.
        .allowlist_function("whisper_.*")
        .allowlist_type("whisper_.*")
        .allowlist_var("WHISPER_.*")
        .allowlist_type("ggml_log_callback")
        .allowlist_type("ggml_abort_callback")
        .allowlist_type("ggml_log_level")
        .derive_default(true)
        .derive_debug(true)
        .layout_tests(false)
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("bindgen failed");

    bindings
        .write_to_file(out_dir.join("whisper_bindings.rs"))
        .expect("write whisper_bindings.rs");
}
