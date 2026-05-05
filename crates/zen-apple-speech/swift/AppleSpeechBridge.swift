// Apple Speech bridge — wraps SpeechAnalyzer + SpeechTranscriber
// (macOS 26 / iOS 26, WWDC 2025) behind a synchronous C ABI so the
// Rust side (`crates/zen-apple-speech/src/lib.rs`) can call it from a
// `tokio::task::spawn_blocking` worker without juggling Swift
// concurrency.
//
// All exported functions are `@_cdecl`-prefixed so the symbol names
// match what `extern "C"` declares on the Rust side. Return codes
// follow `errno`-style conventions: 0 on success, negative on error,
// with an out-pointer for an optional UTF-8 error message that the
// caller must free via `apple_speech_string_free`.
//
// Why SpeechTranscriber and not DictationTranscriber:
//   The macOS 26 SDK ships both. SpeechTranscriber's init signature
//   (locale + transcriptionOptions/reportingOptions/attributeOptions)
//   is well-documented in the WWDC sessions and the FluidInference
//   swift-scribe reference (see `vendor docs`). DictationTranscriber's
//   exact init is less well-documented at the time of writing — its
//   `results` stream and overall analyzer integration are identical,
//   so swapping is a one-line change once the user verifies the
//   signature against their installed Xcode 26 SDK. Marker comment
//   `// SWAP-FOR-DICTATION-TRANSCRIBER` flags the spot.

import Foundation
import Speech
@preconcurrency import AVFoundation

// MARK: - Error helpers

/// Allocate a heap-owned C string the Rust caller frees with
/// `apple_speech_string_free`. Wraps `strdup` because Swift's
/// `String.utf8CString` returns a `ContiguousArray` that doesn't
/// outlive its scope.
private func cstrdup(_ s: String) -> UnsafeMutablePointer<CChar>? {
    return s.withCString { strdup($0) }
}

@_cdecl("apple_speech_string_free")
public func apple_speech_string_free(_ p: UnsafeMutablePointer<CChar>?) {
    guard let p = p else { return }
    free(p)
}

// MARK: - Capability check

/// `1` when the running OS is macOS 26+, `0` otherwise. Distinct from
/// "the bridge was compiled with the macOS 26 SDK" — that's a build-time
/// concern handled in build.rs by emitting a stub when the SDK is too
/// old, so by the time this function exists in the dylib the SDK was
/// new enough; we still need a runtime gate because the user could be
/// running the bundled binary on an older OS than it was built against.
@_cdecl("apple_speech_is_supported")
public func apple_speech_is_supported() -> Int32 {
    if #available(macOS 26.0, *) {
        return 1
    }
    return 0
}

// MARK: - Locale helpers (gated on macOS 26)

@available(macOS 26.0, *)
private func parseLocale(_ s: String) -> Locale {
    // Accept both "en-US" and "en_US" forms; Locale's initializer
    // handles both. We pass through verbatim so the caller's choice
    // round-trips into AssetInventory exactly.
    return Locale(identifier: s)
}

@available(macOS 26.0, *)
private func isLocaleInstalled(_ locale: Locale) async -> Bool {
    let installed = await SpeechTranscriber.installedLocales
    let bcp47 = locale.identifier(.bcp47)
    return installed.contains { $0.identifier(.bcp47) == bcp47 }
}

@available(macOS 26.0, *)
private func isLocaleSupported(_ locale: Locale) async -> Bool {
    let supported = await SpeechTranscriber.supportedLocales
    let bcp47 = locale.identifier(.bcp47)
    return supported.contains { $0.identifier(.bcp47) == bcp47 }
}

// MARK: - locale_installed

/// Returns 1 if the locale is installed, 0 if not, -1 on error
/// (unsupported OS, unparseable locale, etc.). `out_error` is set to
/// a malloc'd UTF-8 string when the return is -1 — caller frees with
/// `apple_speech_string_free`.
@_cdecl("apple_speech_locale_installed")
public func apple_speech_locale_installed(
    _ locale: UnsafePointer<CChar>?,
    _ out_error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard #available(macOS 26.0, *) else {
        out_error?.pointee = cstrdup("apple speech requires macOS 26 or later")
        return -1
    }
    guard let locale = locale else {
        out_error?.pointee = cstrdup("locale is null")
        return -1
    }
    let id = String(cString: locale)
    let parsed = parseLocale(id)

    let sema = DispatchSemaphore(value: 0)
    var installed = false
    Task {
        installed = await isLocaleInstalled(parsed)
        sema.signal()
    }
    sema.wait()
    return installed ? 1 : 0
}

// MARK: - install_locale

/// Synchronously download and install the locale's speech model.
/// Blocks the calling thread (the Rust side runs this from a
/// `spawn_blocking` worker, so blocking is fine).
///
/// Returns 0 on success. On error, -1 with `out_error` set to a
/// caller-freed UTF-8 string.
///
/// We deliberately do **not** stream progress through a callback yet:
/// the call is synchronous and AssetInventory's `Progress` object
/// doesn't easily map to a C callback without retain juggling. The
/// frontend gets a single "installing…" indicator while this runs.
/// Adding granular progress is a follow-up — wire a callback that
/// pumps `downloader.progress.fractionCompleted` from a periodic
/// `DispatchSourceTimer`.
@_cdecl("apple_speech_install_locale")
public func apple_speech_install_locale(
    _ locale: UnsafePointer<CChar>?,
    _ out_error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard #available(macOS 26.0, *) else {
        out_error?.pointee = cstrdup("apple speech requires macOS 26 or later")
        return -1
    }
    guard let locale = locale else {
        out_error?.pointee = cstrdup("locale is null")
        return -1
    }
    let id = String(cString: locale)
    let parsed = parseLocale(id)

    let sema = DispatchSemaphore(value: 0)
    var rc: Int32 = 0
    var errMessage: String? = nil

    Task {
        defer { sema.signal() }
        do {
            // Build a throwaway transcriber so AssetInventory knows
            // which assets we want. We don't keep this transcriber
            // around — the per-call create() inside `transcribe`
            // builds a fresh one bound to the analyzer.
            let probe = SpeechTranscriber(
                locale: parsed,
                transcriptionOptions: [],
                reportingOptions: [],
                attributeOptions: [])
            // SWAP-FOR-DICTATION-TRANSCRIBER: replace `SpeechTranscriber`
            // with `DictationTranscriber(locale: parsed)` once verified
            // against the installed Xcode 26 SDK headers.

            if !(await isLocaleSupported(parsed)) {
                errMessage = "locale \(id) is not supported by SpeechTranscriber"
                rc = -1
                return
            }

            if let downloader = try await AssetInventory.assetInstallationRequest(
                supporting: [probe])
            {
                try await downloader.downloadAndInstall()
            }
            // Reserve the locale so subsequent transcription calls
            // succeed without a per-call reservation race.
            let reserved = await AssetInventory.reservedLocales
            if !reserved.contains(where: { $0.identifier(.bcp47) == parsed.identifier(.bcp47) }) {
                try await AssetInventory.reserve(locale: parsed)
            }
        } catch {
            errMessage = "install failed: \(error.localizedDescription)"
            rc = -1
        }
    }
    sema.wait()
    if rc != 0, let msg = errMessage {
        out_error?.pointee = cstrdup(msg)
    }
    return rc
}

// MARK: - Transcriber handle

@available(macOS 26.0, *)
private final class TranscriberBox {
    let locale: Locale
    init(locale: Locale) { self.locale = locale }
}

/// Create a transcriber handle. The handle is opaque to Rust; it just
/// stores the locale. The actual `SpeechTranscriber` + `SpeechAnalyzer`
/// instances are built fresh per `transcribe` call because the Apple
/// API expects the input AsyncStream to be supplied at `analyzer.start`
/// time and the stream is consumed once. Reusing the analyzer across
/// calls would require tee-ing a continuation; we trade that small
/// startup cost (a few ms after the first call once assets are warm)
/// for a much simpler bridge.
@_cdecl("apple_speech_create")
public func apple_speech_create(_ locale: UnsafePointer<CChar>?) -> OpaquePointer? {
    guard #available(macOS 26.0, *) else { return nil }
    guard let locale = locale else { return nil }
    let id = String(cString: locale)
    let box = TranscriberBox(locale: parseLocale(id))
    return OpaquePointer(Unmanaged.passRetained(box).toOpaque())
}

@_cdecl("apple_speech_destroy")
public func apple_speech_destroy(_ handle: OpaquePointer?) {
    guard #available(macOS 26.0, *) else { return }
    guard let handle = handle else { return }
    let raw = UnsafeMutableRawPointer(handle)
    Unmanaged<TranscriberBox>.fromOpaque(raw).release()
}

// MARK: - transcribe

/// Synchronous transcribe of a 16 kHz f32 mono PCM buffer.
///
/// On success: returns 0, `out_text` set to a malloc'd UTF-8 string
/// (caller frees with `apple_speech_string_free`).
/// On error: returns -1, `out_text` set to a malloc'd UTF-8 error
/// message (also freed with `apple_speech_string_free`).
@_cdecl("apple_speech_transcribe")
public func apple_speech_transcribe(
    _ handle: OpaquePointer?,
    _ samples: UnsafePointer<Float>?,
    _ n_samples: UInt,
    _ out_text: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard #available(macOS 26.0, *) else {
        out_text?.pointee = cstrdup("apple speech requires macOS 26 or later")
        return -1
    }
    guard let handle = handle, let samples = samples, n_samples > 0 else {
        out_text?.pointee = cstrdup("invalid arguments")
        return -1
    }

    let raw = UnsafeMutableRawPointer(handle)
    let box = Unmanaged<TranscriberBox>.fromOpaque(raw).takeUnretainedValue()
    let locale = box.locale

    // Build an AVAudioPCMBuffer at 16 kHz f32 mono from the supplied
    // samples. SpeechAnalyzer will internally convert this to whatever
    // the model's preferred format is via
    // `bestAvailableAudioFormat(compatibleWith:)`.
    guard let inputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false)
    else {
        out_text?.pointee = cstrdup("could not construct AVAudioFormat")
        return -1
    }

    guard let inputBuffer = AVAudioPCMBuffer(
        pcmFormat: inputFormat,
        frameCapacity: AVAudioFrameCount(n_samples))
    else {
        out_text?.pointee = cstrdup("could not allocate AVAudioPCMBuffer")
        return -1
    }
    inputBuffer.frameLength = AVAudioFrameCount(n_samples)
    if let dest = inputBuffer.floatChannelData {
        // memcpy is safe — same primitive type, contiguous storage.
        memcpy(dest[0], samples, Int(n_samples) * MemoryLayout<Float>.size)
    } else {
        out_text?.pointee = cstrdup("AVAudioPCMBuffer has no floatChannelData")
        return -1
    }

    let sema = DispatchSemaphore(value: 0)
    var rc: Int32 = 0
    var resultText: String = ""
    var errMessage: String? = nil

    Task {
        defer { sema.signal() }
        do {
            // Build a fresh transcriber + analyzer for this call.
            let transcriber = SpeechTranscriber(
                locale: locale,
                transcriptionOptions: [],
                reportingOptions: [],
                attributeOptions: [])
            // SWAP-FOR-DICTATION-TRANSCRIBER: see `apple_speech_install_locale`.

            // Up-front availability checks so we can return a clear
            // error rather than a generic "analyzer failed".
            if !(await isLocaleSupported(locale)) {
                errMessage = "locale \(locale.identifier) is not supported"
                rc = -1
                return
            }
            if !(await isLocaleInstalled(locale)) {
                errMessage = "locale \(locale.identifier) model is not installed; click Install in settings"
                rc = -1
                return
            }

            let analyzer = SpeechAnalyzer(modules: [transcriber])

            // Convert to the model's preferred format if it differs
            // from our 16 kHz f32 mono input.
            let workingBuffer: AVAudioPCMBuffer
            if let preferred = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber]),
               preferred != inputFormat
            {
                guard let converter = AVAudioConverter(from: inputFormat, to: preferred),
                      let converted = AVAudioPCMBuffer(
                            pcmFormat: preferred,
                            frameCapacity: AVAudioFrameCount(
                                Double(n_samples) * preferred.sampleRate / 16_000.0) + 1024)
                else {
                    errMessage = "audio converter setup failed"
                    rc = -1
                    return
                }
                var error: NSError?
                let status = converter.convert(to: converted, error: &error) { _, outStatus in
                    outStatus.pointee = .haveData
                    return inputBuffer
                }
                if status == .error {
                    errMessage = "audio conversion failed: \(error?.localizedDescription ?? "unknown")"
                    rc = -1
                    return
                }
                workingBuffer = converted
            } else {
                workingBuffer = inputBuffer
            }

            // One-shot input stream: yield the buffer, then finish.
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()

            // Collect results on a child task so we can read them
            // after the analyzer reports end-of-input.
            let collector = Task<String, Error> {
                var collected = ""
                for try await result in transcriber.results {
                    if result.isFinal {
                        // `text` is an AttributedString — concatenate
                        // its character view as plain text. Discards
                        // the timing/voicing attributes, which we
                        // don't need for paste-at-cursor.
                        collected += String(result.text.characters)
                    }
                }
                return collected
            }

            try await analyzer.start(inputSequence: stream)
            continuation.yield(AnalyzerInput(buffer: workingBuffer))
            continuation.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()

            resultText = try await collector.value
        } catch {
            errMessage = "transcribe failed: \(error.localizedDescription)"
            rc = -1
        }
    }
    sema.wait()

    if rc != 0 {
        out_text?.pointee = cstrdup(errMessage ?? "unknown error")
        return rc
    }
    out_text?.pointee = cstrdup(
        resultText.trimmingCharacters(in: .whitespacesAndNewlines))
    return 0
}
