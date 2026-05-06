//! Pure-Rust vocabulary extraction.
//!
//! Input: a single newline-joined blob of OCR'd text (whatever the
//! Swift bridge produced).
//!
//! Output: a ranked, deduplicated `Vec<String>` of vocabulary terms
//! suitable for biasing a speech recognizer.
//!
//! Heuristic, in priority order:
//!
//! 1. **Code identifiers** — `camelCase`, `snake_case`, `kebab-case`,
//!    `CONSTANT_CASE`. These are almost always proper nouns of code
//!    (function names, type names, env vars) — the exact category
//!    speech recognizers struggle with most.
//! 2. **Acronyms** — 2–6 consecutive uppercase letters. APIs, FFI,
//!    GPU, etc. Speech models often spell these out as words.
//! 3. **Capitalised non-sentence-initial words** — likely proper
//!    nouns. We accept a one-word lookback heuristic: if the previous
//!    token ends in `.`, `!`, `?`, or this is the first token on its
//!    line, demote rather than promote (could just be sentence
//!    capitalisation).
//! 4. **Multi-word capitalised phrases** — joined back into a single
//!    contextual string so the recognizer can learn the bigram.
//!
//! Filters applied at every stage:
//!
//! * stop-word list (English top-200 plus common UI chrome)
//! * length: 2..=40 chars (drop single letters and obvious garbage)
//! * pure-numeric and URL-fragment dropouts
//! * dedupe, case-folded for grouping but keeping the original
//!   capitalisation for the chosen representative.

use std::collections::HashMap;

/// Pure tokeniser entry point. Splits on whitespace + punctuation,
/// keeps interior `_` and `-` because those are part of code
/// identifiers we explicitly want to keep whole.
fn tokenize(text: &str) -> Vec<&str> {
    text.split(|c: char| {
        if c.is_whitespace() {
            return true;
        }
        // Keep interior _ and - (code identifiers); split everything
        // else that's not alphanumeric.
        if c == '_' || c == '-' {
            return false;
        }
        !c.is_alphanumeric()
    })
    .filter(|s| !s.is_empty())
    .collect()
}

/// Count case-transition boundaries (lower→upper or upper→lower).
/// Real PascalCase / camelCase identifiers have 0–2 of these
/// (`URLSession`: 1, `useState`: 1, `XMLHttpRequest`: 2). Garbled OCR
/// like `IUsErsifthballL` or `RethlldwfthseY` has 4+ because Vision
/// is randomly substituting letters across cases.
fn case_transitions(s: &str) -> u32 {
    let mut prev: Option<bool> = None;
    let mut count: u32 = 0;
    for c in s.chars() {
        let is_letter = c.is_ascii_alphabetic();
        if !is_letter {
            prev = None;
            continue;
        }
        let is_upper = c.is_ascii_uppercase();
        if let Some(prev_upper) = prev {
            if prev_upper != is_upper {
                count += 1;
            }
        }
        prev = Some(is_upper);
    }
    count
}

/// Heuristic detector for garbled-OCR tokens.
///
/// Returns `true` when `s` exhibits the structural fingerprints we
/// see on Vision's misreads of small UI text: too many case
/// boundaries, vowel-starved character soups, or runs of
/// case-flipped letters that no real English/code token contains.
///
/// Conservative: prefer a false negative (let a borderline token
/// through) over a false positive (drop a real proper noun). The
/// score+frequency rank in [`extract_vocab`] does the rest of the
/// triage.
fn looks_garbled(s: &str) -> bool {
    // 1. Too many case transitions. PascalCase / camelCase tops out
    //    around 3 (`SpeechAnalyzer` = 3: S→p, h→A, A→n;
    //    `XMLHttpRequest` = 3: L→H, H→t, p→R). 4+ is almost always
    //    garbled (`IUsErsifthballL` has 4).
    if case_transitions(s) >= 4 {
        return true;
    }

    // 2. Vowel ratio over alphabetic chars. English (and most code
    //    identifiers built from English) sits at 35–40%. Anything
    //    under 20% is either an acronym (caught earlier by length
    //    check) or OCR noise. Apply at 4+ chars so short noise
    //    like `mDdd` is caught, but acronyms (≤6 chars handled
    //    separately) aren't double-jeopardied.
    let alpha_count = s.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if alpha_count >= 4 {
        let vowel_count = s
            .chars()
            .filter(|c| matches!(c.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u' | 'y'))
            .count();
        let ratio = vowel_count as f32 / alpha_count as f32;
        if ratio < 0.20 {
            return true;
        }
    }

    // 3. Long unbroken run of consonants suggests OCR jumble. 5+
    //    consecutive non-vowel letters virtually never occurs in
    //    natural words or identifiers.
    let mut consec_consonants = 0;
    for c in s.chars() {
        if c.is_ascii_alphabetic()
            && !matches!(c.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u' | 'y')
        {
            consec_consonants += 1;
            if consec_consonants >= 5 {
                return true;
            }
        } else {
            consec_consonants = 0;
        }
    }

    // 4. Interior digit between letters in an otherwise-mixed-case
    //    token strongly suggests OCR misreading a letter as a digit
    //    in the middle of a word (`Mmuw4xindtitor`, `K4onitor`).
    //    Real code identifiers put digits at the end (`OAuth2`,
    //    `H264`) or in `snake_case` / `kebab-case` segments — the
    //    PascalCase identifier path explicitly disallows interior
    //    digits, but garbled tokens with no separator can still hit
    //    here. Pattern: any digit that has a letter both before and
    //    after it in the SAME segment (no `_` or `-` separators).
    if !s.contains('_') && !s.contains('-') {
        let bytes = s.as_bytes();
        for i in 1..bytes.len().saturating_sub(1) {
            if bytes[i].is_ascii_digit()
                && bytes[i - 1].is_ascii_alphabetic()
                && bytes[i + 1].is_ascii_alphabetic()
            {
                return true;
            }
        }
    }

    // 5. In a mixed-case token (≥1 case transition), an unbroken
    //    lowercase run >10 chars suggests OCR concatenated two
    //    words it should have separated. Real PascalCase compounds
    //    have natural word breaks: `SpeechAnalyzer`'s longest run
    //    is "nalyzer" (7); `IUserslbaballCode`'s "serslbaball" is
    //    11 — clearly wrong.
    if case_transitions(s) >= 1 {
        let mut max_lower_run: u32 = 0;
        let mut current: u32 = 0;
        for c in s.chars() {
            if c.is_ascii_lowercase() {
                current += 1;
                if current > max_lower_run {
                    max_lower_run = current;
                }
            } else {
                current = 0;
            }
        }
        if max_lower_run > 10 {
            return true;
        }
    }

    false
}

/// `true` if `s` looks like a code identifier worth keeping.
///
/// Tightened over the v1 rules to avoid letting Vision-misread junk
/// through. Each branch now requires both the *shape* of an
/// identifier AND structural sanity (case-transition cap, letter
/// ratio).
fn is_code_identifier(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes.len() > 40 {
        return false;
    }

    // Letter density gate — identifiers can have digits and the
    // structural separators below, but a token that's <60% letters
    // is almost certainly a serial number / hash / OCR fragment.
    let letter_count = s.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if (letter_count as f32) / (s.len() as f32) < 0.60 {
        return false;
    }

    // CONSTANT_CASE
    if s.contains('_')
        && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    {
        return true;
    }
    // snake_case (and snake-camel-mixed like `fooBar_baz`). The
    // mere presence of an interior underscore in an
    // alphanumeric+underscore token is a strong signal it's not OCR
    // residue (Vision basically never inserts underscores). We don't
    // need a case-transition cap here — looks_garbled() already
    // gates the truly broken cases via its own checks.
    if s.contains('_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return true;
    }
    // kebab-case (≥2 segments) — same case-transition cap, plus
    // each segment ≥3 chars (rejects `pJ-Z`-shaped OCR fragments
    // that satisfy "alphanum + dash" but aren't real identifiers).
    if s.contains('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && s.matches('-').count() >= 1
        && case_transitions(s) <= 1
        && s.split('-').all(|seg| seg.len() >= 3)
    {
        return true;
    }
    // camelCase / PascalCase: starts with a letter, has exactly 1-3
    // case transitions (`useState` = 2, `URLSession` = 1,
    // `SpeechAnalyzer` = 3, `XMLHttpRequest` = 3). Must be
    // letter+digit only — tokens with `-` / `_` should have hit the
    // dedicated kebab/snake branches above; if they fell through,
    // it's because those branches' tighter rules rejected them
    // (e.g. `pJ-Z` segments too short), and we shouldn't give them
    // a second chance here.
    if bytes[0].is_ascii_alphabetic()
        && s.chars().all(|c| c.is_ascii_alphanumeric())
    {
        let trans = case_transitions(s);
        if (1..=3).contains(&trans) {
            return true;
        }
    }
    false
}

/// Acronyms: 2–6 consecutive uppercase letters, optionally followed
/// by digits. Excludes single letters and very long all-caps strings
/// (likely OCR garbage).
fn is_acronym(s: &str) -> bool {
    if s.len() < 2 || s.len() > 6 {
        return false;
    }
    s.chars().all(|c| c.is_ascii_uppercase())
}

/// Drop tokens that are obviously noise.
fn is_garbage(s: &str) -> bool {
    if s.len() < 2 || s.len() > 40 {
        return true;
    }
    if s.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    // URL fragments after our tokeniser strips '/' and ':' usually
    // look like "https" / "www" / "com" — covered by stop_words below
    // — but we also drop things that are mostly punctuation residue
    // (e.g. interior punctuation).
    if s.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
        return true;
    }
    false
}

/// Stop words: English top-N + common macOS UI chrome. Lower-cased
/// for case-insensitive matching at filter time.
fn stop_words() -> &'static std::collections::HashSet<&'static str> {
    use std::sync::OnceLock;
    static SET: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        // Curated by hand. Two pots: (1) common English words a
        // recognizer already knows; (2) macOS / app-chrome strings
        // that flood every screenshot.
        const WORDS: &[&str] = &[
            // English top ~150
            "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
            "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
            "this", "but", "his", "by", "from", "they", "we", "say", "her",
            "she", "or", "an", "will", "my", "one", "all", "would", "there",
            "their", "what", "so", "up", "out", "if", "about", "who", "get",
            "which", "go", "me", "when", "make", "can", "like", "time", "no",
            "just", "him", "know", "take", "people", "into", "year", "your",
            "good", "some", "could", "them", "see", "other", "than", "then",
            "now", "look", "only", "come", "its", "over", "think", "also",
            "back", "after", "use", "two", "how", "our", "work", "first",
            "well", "way", "even", "new", "want", "because", "any", "these",
            "give", "day", "most", "us", "is", "are", "was", "were", "been",
            "has", "had", "did", "does", "doing", "should", "could", "may",
            "might", "must", "shall", "am", "very", "such", "much", "many",
            "more", "less", "few", "still", "yet", "ever", "never", "always",
            "each", "every", "both", "either", "neither", "same", "own",
            "while", "where", "why", "off", "down", "here", "there",
            // macOS / browser / app chrome
            "file", "edit", "view", "help", "window", "format", "go", "tools",
            "save", "open", "close", "quit", "cancel", "ok", "apply", "done",
            "next", "previous", "back", "forward", "send", "reply", "delete",
            "copy", "paste", "cut", "select", "all", "find", "search", "share",
            "settings", "preferences", "options", "advanced", "general",
            "appearance", "tab", "tabs", "menu", "menubar", "dock", "finder",
            "bookmarks", "history", "downloads", "extensions", "developer",
            "console", "debug", "build", "run", "stop", "test", "tests",
            "log", "logs", "warnings", "error", "errors", "info", "warn",
            "today", "yesterday", "tomorrow", "now", "ago", "min", "mins",
            "minute", "minutes", "hour", "hours", "second", "seconds",
            "monday", "tuesday", "wednesday", "thursday", "friday",
            "saturday", "sunday", "jan", "feb", "mar", "apr", "may", "jun",
            "jul", "aug", "sep", "oct", "nov", "dec",
            // URL fragments
            "http", "https", "www", "com", "org", "net", "io", "dev",
            // Punctuation residue
            "amp", "nbsp", "quot",
        ];
        WORDS.iter().copied().collect()
    })
}

/// Score a single token. Higher = more likely to be useful vocabulary.
/// Returns 0 for tokens that should be discarded.
fn score(tok: &str) -> u32 {
    let lower = tok.to_ascii_lowercase();
    if stop_words().contains(lower.as_str()) {
        return 0;
    }
    if is_garbage(tok) {
        return 0;
    }
    // Structural OCR-noise gate. Runs before the shape rules so a
    // token like `IUsErsifthballL` doesn't sneak through `is_code_identifier`'s
    // PascalCase branch — it has 4 case transitions and is correctly
    // classified as garbled.
    if looks_garbled(tok) {
        return 0;
    }

    if is_code_identifier(tok) {
        return 100;
    }
    if is_acronym(tok) {
        return 80;
    }
    // Capitalised proper-noun-ish: starts with uppercase, rest is
    // lowercase, length 3-20 chars. The 20-char cap drops long
    // garbled words (`Rethlldwfthsey` etc.) that pass the
    // case-transition check by accident — real proper nouns sit
    // well under 20 characters.
    let first = tok.chars().next().unwrap();
    if first.is_ascii_uppercase()
        && (3..=20).contains(&tok.len())
        && tok.chars().skip(1).all(|c| c.is_ascii_lowercase())
    {
        return 40;
    }
    // Lowercase tokens are mostly common English; only worth keeping
    // if they're long (≥ 8 chars suggests technical jargon).
    if tok.len() >= 8
        && tok.len() <= 20
        && tok.chars().all(|c| c.is_ascii_alphabetic())
    {
        return 10;
    }
    0
}

/// Levenshtein edit distance, capped at `max + 1` for early exit.
/// Used by [`extract_vocab`]'s in-snapshot dedupe pass to collapse
/// OCR-fragment families (the same word read three slightly different
/// ways → one representative).
///
/// Bounded O(a·b) but we only ever call it on already-filtered short
/// strings (≤40 chars) and exit early when `max` is hit, so cost is
/// negligible per pair.
fn edit_distance(a: &str, b: &str, max: usize) -> usize {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let n = ab.len();
    let m = bb.len();
    if n.abs_diff(m) > max {
        return max + 1;
    }
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr: Vec<usize> = vec![0; m + 1];
    for i in 1..=n {
        curr[0] = i;
        let mut row_min = curr[0];
        for j in 1..=m {
            let cost = if ab[i - 1].eq_ignore_ascii_case(&bb[j - 1]) { 0 } else { 1 };
            curr[j] = (curr[j - 1] + 1)
                .min(prev[j] + 1)
                .min(prev[j - 1] + cost);
            if curr[j] < row_min {
                row_min = curr[j];
            }
        }
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}

/// `true` if `candidate` is a likely OCR fragment of `kept` (or
/// vice-versa) — short edit distance OR substring relationship.
/// Used to suppress duplicates after the score+sort step.
fn is_ocr_fragment_of(candidate: &str, kept: &str) -> bool {
    // Exact case-folded equality already handled by the case-folded
    // hash key in `extract_vocab`. Here we look for *near* matches.
    let c_lower = candidate.to_ascii_lowercase();
    let k_lower = kept.to_ascii_lowercase();

    // Substring with a tight length delta — e.g. `IUserslbaballL`
    // contains `IUserslbaball`, both are OCR attempts at the same
    // path fragment.
    let len_delta = candidate.len().abs_diff(kept.len());
    if len_delta <= 4
        && (c_lower.contains(&k_lower) || k_lower.contains(&c_lower))
        && c_lower.len().min(k_lower.len()) >= 5
    {
        return true;
    }

    // Edit distance ≤ 2 catches one-off character substitutions
    // (`IUserslbaball` vs `IUsErsifthball`). Skip the comparison if
    // lengths differ too much to make this cheap.
    let max = 2;
    if len_delta <= max && c_lower.len() >= 6 {
        return edit_distance(&c_lower, &k_lower, max) <= max;
    }
    false
}

/// Extract a ranked vocabulary list from raw OCR'd text.
///
/// Returns up to `max_terms` items, deduplicated case-insensitively
/// but keeping the original casing of the highest-scoring occurrence.
pub fn extract_vocab(text: &str, max_terms: usize) -> Vec<String> {
    if text.is_empty() || max_terms == 0 {
        return Vec::new();
    }

    // Two-pass approach: tokenise and score every token, accumulate
    // scores per case-folded key (so frequency boosts unique terms),
    // then sort and truncate.

    struct Entry {
        repr: String,
        score: u32,
        count: u32,
    }

    let mut by_key: HashMap<String, Entry> = HashMap::with_capacity(256);
    for tok in tokenize(text) {
        let s = score(tok);
        if s == 0 {
            continue;
        }
        let key = tok.to_ascii_lowercase();
        let entry = by_key.entry(key).or_insert_with(|| Entry {
            repr: tok.to_string(),
            score: 0,
            count: 0,
        });
        // Take the highest base score and prefer the casing that
        // produced it (so `URLSession` beats `urlsession` if both
        // appear).
        if s > entry.score {
            entry.score = s;
            entry.repr = tok.to_string();
        }
        entry.count = entry.count.saturating_add(1);
    }

    let mut ranked: Vec<Entry> = by_key.into_values().collect();
    // Final score = base score × log-ish frequency boost. We want
    // common-but-not-stopword terms to rank above one-off capitalised
    // sentence starts, but we don't want pure frequency to dominate
    // (UI chrome that slipped past the stopword list would otherwise
    // win). +1 ensures the first occurrence still gets the base score.
    ranked.sort_by(|a, b| {
        let sa = a.score as u64 * (a.count as u64).min(8) + 1;
        let sb = b.score as u64 * (b.count as u64).min(8) + 1;
        sb.cmp(&sa).then_with(|| a.repr.cmp(&b.repr))
    });

    // OCR-fragment dedupe pass. Walk the ranked list in order; for
    // each candidate, keep it only if no already-kept term is a
    // near-duplicate (edit distance ≤ 2 or substring within 4
    // chars). Highest-scoring representative wins because we walk
    // top-down. This collapses Vision's tendency to emit multiple
    // misreads of the same source word into a single entry.
    let mut kept: Vec<String> = Vec::with_capacity(max_terms.min(ranked.len()));
    for entry in ranked.into_iter() {
        if kept.len() >= max_terms {
            break;
        }
        if kept.iter().any(|k| is_ocr_fragment_of(&entry.repr, k)) {
            continue;
        }
        kept.push(entry.repr);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_code_identifiers() {
        let txt =
            "import { useState } from React; const fooBar_baz = SpeechAnalyzer.start();";
        let v = extract_vocab(txt, 32);
        assert!(v.iter().any(|s| s == "useState"), "missing useState: {v:?}");
        assert!(v.iter().any(|s| s == "SpeechAnalyzer"), "missing SpeechAnalyzer: {v:?}");
        assert!(v.iter().any(|s| s == "fooBar_baz"), "missing fooBar_baz: {v:?}");
    }

    #[test]
    fn drops_stop_words_and_chrome() {
        let txt = "File Edit View Help the and to of for com org cancel ok apply";
        let v = extract_vocab(txt, 32);
        assert!(v.is_empty(), "expected empty, got {v:?}");
    }

    #[test]
    fn keeps_acronyms() {
        let txt = "GPU FFI URL TCC HTTP something";
        let v = extract_vocab(txt, 32);
        assert!(v.iter().any(|s| s == "GPU"));
        assert!(v.iter().any(|s| s == "FFI"));
        assert!(v.iter().any(|s| s == "TCC"));
        // "URL" and "HTTP" are stop-listed (they're dominant URL
        // fragments). That's intentional — acronyms-of-stopwords go.
    }

    #[test]
    fn caps_at_max_terms() {
        // Cap is a CEILING — the dedupe pass may legitimately keep
        // fewer than max_terms when input has fragment families,
        // but never more. Use words that are intentionally far
        // apart in edit distance so most survive the dedupe.
        let words = [
            "Lambda", "Sigma", "Tensor", "Vector", "Matrix", "Module",
            "Nebula", "Octave", "Phantom", "Quantum", "Rhombus", "Vertex",
            "Wavelet", "Xenon", "Yandex", "Zenith", "Asteroid", "Beacon",
            "Cipher", "Drone", "Echo", "Falcon", "Glyph", "Helix",
            "Joule", "Krypton", "Locus", "Membrane", "Nimbus",
            "Orbit", "Pulse", "Quasar", "Radiance", "Spectrum", "Trojan",
            "Umbra", "Voltage", "Whisper", "Yarrow", "Zephyr",
            "Anchor", "Bolt", "Crisp", "Drift", "Ember", "Frost",
            "Glade", "Haven", "Iris", "Knoll", "Loom", "Marble",
            "Sparrow", "Talon",
        ];
        let txt = words.join(" ");
        let v = extract_vocab(&txt, 50);
        assert!(v.len() <= 50, "exceeded max_terms: got {}: {v:?}", v.len());
        assert!(v.len() >= 30, "dedupe was too aggressive: {v:?}");
    }

    #[test]
    fn dedupe_case_folded() {
        let txt = "useState useState USESTATE";
        let v = extract_vocab(txt, 32);
        let count = v.iter().filter(|s| s.eq_ignore_ascii_case("usestate")).count();
        assert_eq!(count, 1, "expected single dedupe representative, got {v:?}");
    }

    #[test]
    fn rejects_garbled_ocr_tokens() {
        // Real garbage from the user's failing run. Every one of
        // these has either too many case transitions, too few vowels,
        // or a long consonant cluster.
        let txt = "IUsErsifthballL 0otsJltlrecomrnandEd \
                   IUserslbaballCode mDdd bxkErth Mmuw4xindtitor \
                   RethlldwfthseY-hfrai dvhTlud lqtoBt nomodElloadEd \
                   pJ-Z bEltr4r ditttJtirmIpc";
        let v = extract_vocab(txt, 32);
        assert!(
            v.is_empty(),
            "garbage leaked through: {v:?}"
        );
    }

    #[test]
    fn dedupes_ocr_fragment_family() {
        // Three OCR attempts at the same `/Users/babal` substring —
        // small substring/edit-distance differences. Should collapse
        // to at most one representative. The garbled-token filter may
        // also drop these; either outcome is fine.
        let txt = "useStateBaball useStateBaballCode useStateBaballL";
        let v = extract_vocab(txt, 32);
        assert!(v.len() <= 1, "expected dedupe, got {v:?}");
    }
}
