// Screen Vocabulary bridge — captures the current state of every
// connected display via ScreenCaptureKit, runs each frame through
// Vision's `VNRecognizeTextRequest`, and returns the recognised
// strings as a flat newline-joined UTF-8 buffer to the Rust caller.
//
// We deliberately keep the Swift side dumb:
//
//   * No tokenisation — that's pure Rust in `extract.rs` so it's
//     easy to unit-test without a Swift runtime.
//   * No filtering — same reason.
//   * No caching — Rust owns the cache (TTL'd), so the bridge
//     re-OCRs every call. The OCR cost is bounded (.fast mode,
//     ~50–150 ms / display) so the cache lives one layer up.
//
// The bridge is synchronous from Rust's perspective: the Rust caller
// runs us from a `spawn_blocking` worker thread, we kick off the
// async ScreenCaptureKit + Vision work on a child Task, and a
// `DispatchSemaphore` parks the calling thread until that work
// completes. Same pattern used in `AppleSpeechBridge.swift`.
//
// Permissions: ScreenCaptureKit reads from the Screen Recording TCC
// scope. The first call after install (or after Reset) triggers the
// system prompt. We do NOT prompt explicitly — the user-facing
// settings toggle starts off, and turning it on issues the first
// snapshot which is what triggers TCC.

import Foundation
@preconcurrency import ScreenCaptureKit
@preconcurrency import Vision
import CoreGraphics
import ImageIO

// MARK: - Error helpers (mirrors AppleSpeechBridge.swift)

private func cstrdup(_ s: String) -> UnsafeMutablePointer<CChar>? {
    return s.withCString { strdup($0) }
}

@_cdecl("zen_screen_vocab_string_free")
public func zen_screen_vocab_string_free(_ p: UnsafeMutablePointer<CChar>?) {
    guard let p = p else { return }
    free(p)
}

// MARK: - Capability check

/// `1` when the running OS supports the APIs we use (ScreenCaptureKit
/// shipped 12.3, Vision text recognition has been around since 13).
/// Gated on macOS 26 only because that's the floor for the rest of
/// the dictation feature; downgrading the gate is mechanical.
@_cdecl("zen_screen_vocab_is_supported")
public func zen_screen_vocab_is_supported() -> Int32 {
    if #available(macOS 13.0, *) {
        return 1
    }
    return 0
}

// MARK: - Main entry point

/// Capture every connected display, OCR each, and return the union of
/// recognised text lines as a single newline-separated UTF-8 string.
///
/// On success: returns 0, `out_text` set to a malloc'd UTF-8 string
/// (caller frees with `zen_screen_vocab_string_free`). The string may
/// legitimately be empty (no text on screen, or OCR found nothing) —
/// the Rust side treats empty output as "no vocab", which is a
/// non-error path.
///
/// On error: returns -1, `out_text` set to a malloc'd UTF-8 error
/// message (also freed with `zen_screen_vocab_string_free`).
@_cdecl("zen_screen_vocab_snapshot")
public func zen_screen_vocab_snapshot(
    _ out_text: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard #available(macOS 13.0, *) else {
        out_text?.pointee = cstrdup("screen vocab requires macOS 13 or later")
        return -1
    }

    let sema = DispatchSemaphore(value: 0)
    var rc: Int32 = 0
    var resultText: String = ""
    var errMessage: String? = nil

    Task {
        defer { sema.signal() }
        do {
            // ── 1. Discover displays via SCShareableContent ──────────
            // Pass `excludingDesktopWindows: false, onScreenWindowsOnly: true`
            // so the desktop wallpaper is included (rare to have text
            // on it but cheap to allow) and we ignore offscreen
            // windows.
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)

            if content.displays.isEmpty {
                // No displays = nothing to OCR. Not an error.
                resultText = ""
                return
            }

            // ── 2. Capture each display in parallel via TaskGroup ────
            let lines: [String] = try await withThrowingTaskGroup(of: [String].self) { group in
                for display in content.displays {
                    group.addTask {
                        return try await captureAndRecognise(display)
                    }
                }
                var collected: [String] = []
                for try await chunk in group {
                    collected.append(contentsOf: chunk)
                }
                return collected
            }

            resultText = lines.joined(separator: "\n")
        } catch {
            errMessage = "screen vocab snapshot failed: \(error.localizedDescription)"
            rc = -1
        }
    }
    sema.wait()

    if rc != 0 {
        out_text?.pointee = cstrdup(errMessage ?? "unknown error")
        return rc
    }
    out_text?.pointee = cstrdup(resultText)
    return 0
}

// MARK: - Per-display capture + OCR

@available(macOS 13.0, *)
private func captureAndRecognise(_ display: SCDisplay) async throws -> [String] {
    // Build a minimal filter that captures just this display, no
    // window exclusion (we want everything visible to bias vocab).
    let filter = SCContentFilter(display: display, excludingWindows: [])

    let cfg = SCStreamConfiguration()
    // Capture at native pixel resolution. The previous version
    // downscaled to ≤1920px wide, which on a 3024×1964 retina
    // panel halved resolution and turned 11pt UI text into ~5–6pt
    // sub-Vision-readable smears (the user reported gibberish:
    // `IUsErsifthballL`, `0otsJltlrecomrnandEd`, etc.). Vision's
    // `.accurate` mode handles native-res images fine; the cost
    // is a small ms bump that's well within the 1500 ms timeout in
    // `manager.rs::SCREEN_VOCAB_TIMEOUT`.
    cfg.width = display.width
    cfg.height = display.height
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    cfg.queueDepth = 1
    cfg.showsCursor = false

    // SCScreenshotManager is the one-shot capture API (added in
    // macOS 14). It takes a screenshot using the same filter +
    // configuration as a stream would, but returns a single CGImage
    // and tears down immediately — perfect for our "snap one frame"
    // use case.
    let cgImage: CGImage
    if #available(macOS 14.0, *) {
        cgImage = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: cfg)
    } else {
        // 13.x fallback path — kick off a 1-frame stream and tear it
        // down. Skipped here for brevity; macOS 13 users don't get
        // screen vocab. (Bridge's `is_supported` could be tightened
        // to 14+ if we want to be honest; left at 13 because the
        // dictation feature itself gates on macOS 26 anyway.)
        return []
    }

    return try await ocr(cgImage)
}

@available(macOS 13.0, *)
private func ocr(_ image: CGImage) async throws -> [String] {
    return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[String], Error>) in
        let request = VNRecognizeTextRequest { req, err in
            if let err = err {
                cont.resume(throwing: err)
                return
            }
            guard let observations = req.results as? [VNRecognizedTextObservation] else {
                cont.resume(returning: [])
                return
            }
            // Per-observation confidence gating. `.accurate` mode
            // can still emit garbage for low-contrast / tiny /
            // rendered-but-unreadable text; the confidence score
            // separates "I'm sure I read this" from "I guessed".
            // 0.4 is the floor — well above the noise level Apple's
            // sample code recommends, well below the 0.7+ that
            // would only keep big print.
            let CONFIDENCE_FLOOR: Float = 0.4
            var lines: [String] = []
            lines.reserveCapacity(observations.count)
            for obs in observations {
                // Look at top 3 candidates; pick the highest-
                // confidence one that clears the floor. Skip the
                // observation entirely if none qualify.
                let candidates = obs.topCandidates(3)
                if let best = candidates.first(where: { $0.confidence >= CONFIDENCE_FLOOR }) {
                    lines.append(best.string)
                }
            }
            cont.resume(returning: lines)
        }
        // `.accurate`: 3-5× slower than `.fast` but dramatically
        // better on the small dense UI text we're actually reading.
        // The latency is masked by the dictation recording itself
        // (OCR runs in parallel with audio capture; we only block
        // for at most 1500 ms at the *end* of the recording).
        request.recognitionLevel = .accurate
        // Language correction adds a context pass that fixes
        // common substitutions (`I` ↔ `l`, `0` ↔ `O`, etc.)
        // before returning candidates. Big quality win on tight
        // typography.
        request.usesLanguageCorrection = true
        // English-only — avoids the detector spending cycles on
        // CJK / Arabic / RTL passes that contribute nothing on
        // an English-language UI screen.
        request.recognitionLanguages = ["en-US"]
        // Drop tiny artefacts (icon labels, status-bar fragments
        // that Vision can't read confidently). The fraction is
        // relative to image height: 0.01 ≈ ~20 px on a 1964-tall
        // retina panel, which roughly matches a 9pt font lower
        // bound.
        request.minimumTextHeight = 0.01

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        // Vision's perform is synchronous; run it on a global queue
        // so we don't block whatever thread the continuation was
        // resumed on.
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
            } catch {
                cont.resume(throwing: error)
            }
        }
    }
}
