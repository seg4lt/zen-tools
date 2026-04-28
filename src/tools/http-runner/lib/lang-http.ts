/**
 * Custom CodeMirror 6 `StreamLanguage` for IntelliJ-style `.http` files.
 *
 * There is no `@codemirror/lang-http` package, so we tokenise by hand —
 * recognising the request separator, annotation comments, METHOD/URL
 * lines, header lines, and `{{variable}}` placeholders. Only the request
 * line and a handful of top-level forms produce highlights; the body is
 * left as plain text (good enough for JSON/XML/HTML by visual inspection).
 */

import { LanguageSupport, StreamLanguage } from "@codemirror/language";

interface HttpState {
  /** `true` when we're in the headers section after a request line. */
  inHeaders: boolean;
  /** `true` when we're in the body section (after the blank line). */
  inBody: boolean;
}

const METHOD_RE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/;
const URL_RE = /^https?:\/\/[^\s]+/;
const PATH_RE = /^[^\s]+/;
const HEADER_RE = /^[A-Za-z0-9-]+(?=:)/;
const ANNOTATION_RE = /^#\s*@[A-Za-z]+/;
const SEPARATOR_RE = /^###/;
const VAR_RE = /^\{\{[^}]+\}\}/;
const INLINE_VAR_RE = /^@[A-Za-z_][A-Za-z0-9_]*/;

const httpStreamLang = StreamLanguage.define<HttpState>({
  name: "http",
  startState: () => ({ inHeaders: false, inBody: false }),
  token(stream, state) {
    if (stream.sol()) {
      // ### request separator
      if (stream.match(SEPARATOR_RE)) {
        state.inHeaders = false;
        state.inBody = false;
        stream.skipToEnd();
        return "meta";
      }
      // # @name / # @depends / # @extract / # @assert
      if (stream.match(ANNOTATION_RE)) {
        stream.skipToEnd();
        return "comment";
      }
      // line comments
      if (stream.match(/^#/) || stream.match(/^\/\//)) {
        stream.skipToEnd();
        return "comment";
      }
      // @var = value (file-level)
      if (stream.match(INLINE_VAR_RE)) {
        return "variableName";
      }
      // METHOD URL line
      if (!state.inHeaders && !state.inBody && stream.match(METHOD_RE)) {
        state.inHeaders = true;
        return "keyword";
      }
      // header line: Key:
      if (state.inHeaders && stream.match(HEADER_RE)) {
        return "propertyName";
      }
      // blank line transitions out of headers into body
      if (state.inHeaders && stream.eol()) {
        state.inHeaders = false;
        state.inBody = true;
        return null;
      }
    }

    // {{variable}} highlight anywhere
    if (stream.match(VAR_RE)) {
      return "variableName";
    }
    // URLs
    if (stream.match(URL_RE)) {
      return "string";
    }
    // tokens after method
    if (stream.peek() && /[^\s]/.test(stream.peek()!)) {
      stream.match(PATH_RE);
      return null;
    }

    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "#" },
  },
});

/** Use as a CodeMirror extension: `extensions: [httpLanguage()]`. */
export function httpLanguage(): LanguageSupport {
  return new LanguageSupport(httpStreamLang);
}
