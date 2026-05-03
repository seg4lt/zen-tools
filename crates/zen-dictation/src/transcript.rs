//! Post-processing for whisper transcripts.
//!
//! Whisper.cpp emits special tokens for non-speech audio segments:
//! `[Music]`, `[BLANK_AUDIO]`, `(silence)`, `[Applause]`, `[Laughter]`,
//! and so on. When the user holds the dictation gesture in a quiet
//! room or while music is playing in the background, the transcript
//! comes back as one of these markers (or just whitespace). We don't
//! want to paste that into the user's editor, and we definitely
//! don't want to clobber their clipboard with it.
//!
//! [`is_likely_speech`] is the gate. The Tauri layer calls it after
//! `finalise_recording` returns and skips the paste path entirely if
//! it returns `false` — including the `NSPasteboard.setString` call,
//! so the user's clipboard stays untouched.

/// Decide whether `transcript` looks like real speech worth pasting.
///
/// Returns `false` for:
///
/// * empty / whitespace-only strings (whisper's default for silence,
///   which `suppress_blank` doesn't always squash);
/// * strings that contain only bracketed non-speech artifacts
///   (`[Music]`, `[BLANK_AUDIO]`, `(silence)`, `[Applause]` …),
///   even repeated;
/// * strings whose alphabetic content, after stripping bracket
///   groups, is shorter than two letters — that catches stray
///   punctuation, ellipses, and the lone "." whisper sometimes emits
///   for very short captures.
///
/// Returns `true` for anything else, including very short utterances
/// like "hi" (which is two alphabetic chars and matches a
/// recognisable word-shape).
pub fn is_likely_speech(transcript: &str) -> bool {
    let trimmed = transcript.trim();
    if trimmed.is_empty() {
        return false;
    }

    // Strip every `[...]` and `(...)` group. Whisper emits its
    // non-speech markers wrapped in one of those, so removing them
    // leaves only what would have been pasted as actual words.
    let stripped = strip_bracket_groups(trimmed);

    // Count alphabetic chars in the survivors. We require at least
    // two — single stray letters from a noisy capture don't count
    // as speech worth pasting.
    let alpha = stripped.chars().filter(|c| c.is_alphabetic()).count();
    alpha >= 2
}

/// Remove every `[...]` and `(...)` group from `s`. Non-greedy: each
/// opening bracket is matched against the next closing bracket of
/// the same kind. Mismatched / unclosed brackets are left in place,
/// which is fine for this heuristic (we're counting alphabetic
/// content, not parsing).
fn strip_bracket_groups(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        let close = match c {
            '[' => Some(']'),
            '(' => Some(')'),
            '{' => Some('}'),
            _ => None,
        };
        if let Some(close) = close {
            // Skip up to and including the matching close bracket.
            let mut closed = false;
            for inner in chars.by_ref() {
                if inner == close {
                    closed = true;
                    break;
                }
            }
            if !closed {
                // Unclosed group — emit a space so we don't
                // accidentally fuse adjacent words.
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::is_likely_speech;

    #[test]
    fn empty_is_not_speech() {
        assert!(!is_likely_speech(""));
        assert!(!is_likely_speech("   "));
        assert!(!is_likely_speech("\n\t "));
    }

    #[test]
    fn music_marker_is_not_speech() {
        assert!(!is_likely_speech("[Music]"));
        assert!(!is_likely_speech("  [Music]  "));
        assert!(!is_likely_speech("[Music][Music]"));
        assert!(!is_likely_speech("[BLANK_AUDIO]"));
        assert!(!is_likely_speech("(silence)"));
        assert!(!is_likely_speech("[Applause]"));
        assert!(!is_likely_speech("[Laughter]"));
    }

    #[test]
    fn punctuation_only_is_not_speech() {
        assert!(!is_likely_speech("..."));
        assert!(!is_likely_speech(". .. ."));
        assert!(!is_likely_speech("—"));
    }

    #[test]
    fn real_words_are_speech() {
        assert!(is_likely_speech("hello"));
        assert!(is_likely_speech("hi"));
        assert!(is_likely_speech("Hello, world."));
        assert!(is_likely_speech("the quick brown fox"));
    }

    #[test]
    fn music_marker_then_real_words_is_speech() {
        // Whisper sometimes emits a marker followed by what it
        // captured anyway — we should still paste the captured part.
        assert!(is_likely_speech("[Music] hello there"));
    }
}
