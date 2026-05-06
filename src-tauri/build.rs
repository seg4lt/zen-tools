fn main() {
    // On macOS we link against two Swift-emitted dylibs whose
    // install_names start with `@rpath/`:
    //
    //   * `libzen_apple_speech_bridge.dylib` (zen-apple-speech)
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
    //     executable in `target/<profile>/` (the speech crate's
    //     build.rs copies it there). `@executable_path/.` resolves
    //     it.
    //   * Bundled `.app`           → Tauri's bundler copies the dylib
    //     into `Contents/Frameworks/` (see `bundle.macOS.frameworks`
    //     in tauri.conf.json). `@executable_path/../Frameworks`
    //     resolves it from `Contents/MacOS/zen-tools`.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/.");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    tauri_build::build()
}
