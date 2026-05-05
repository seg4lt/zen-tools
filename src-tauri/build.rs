fn main() {
    // On macOS the `zen-apple-speech` crate produces a Swift-emitted
    // dylib (`libzen_apple_speech_bridge.dylib`) whose install_name is
    // `@rpath/libzen_apple_speech_bridge.dylib`. Cargo only honors
    // `cargo:rustc-link-arg=...` for artifacts of the package whose
    // build script emitted it, so rpath link-args declared in
    // `crates/zen-apple-speech/build.rs` get silently dropped when the
    // final binary is linked. We have to add them here, in the
    // binary's own build script, or the produced executable ships
    // with zero LC_RPATH entries and crashes at launch with
    // "no LC_RPATH's found".
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
