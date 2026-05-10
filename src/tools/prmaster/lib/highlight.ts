/**
 * Tiny, dependency-free syntax highlighter for AI review snippets.
 *
 * Why not pull in `prism-react-renderer` / `shiki`: the snippets we
 * render are short (a dozen lines, 5-10 lines of context above and
 * below the finding) and we already pay a hefty bundle cost for
 * CodeMirror in the diff viewer. A focused regex pass covering the
 * tokens that matter for code review (keywords, strings, comments,
 * numbers, types) is good enough at < 5 KB and zero new dependencies.
 *
 * Token classes line up with the colours declared in
 * `AiReviewFindingCard.module.css` / Tailwind utility classes used in
 * `AiReviewFindingCard.tsx`:
 *
 *   * `.tok-kw`   keyword            (e.g. `fn`, `let`, `import`)
 *   * `.tok-typ`  type               (PascalCase or `int`, `string`)
 *   * `.tok-str`  string literal     (`"…"`, `'…'`, `` `…` ``)
 *   * `.tok-num`  numeric literal
 *   * `.tok-com`  comment            (`//`, `#`, `/* … *​/`)
 *   * `.tok-pun`  punctuation
 *   * `.tok-fn`   function call
 *
 * The output is an array of `{ text, cls }` segments; the renderer
 * wraps each in a `<span class="tok-<cls>">`. Plain text gets
 * `cls === ""`.
 *
 * The language map normalises common aliases (`ts` → `typescript`,
 * `py` → `python`, etc.) so callers can pass whatever Claude emitted
 * without us caring about the exact string.
 */

export interface Token {
  text: string;
  cls: string;
}

/** Normalise a user-supplied language hint to one of our supported ids. */
export function normaliseLanguage(input?: string | null): SupportedLang | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  switch (s) {
    case "rs":
    case "rust":
      return "rust";
    case "ts":
    case "typescript":
    case "tsx":
      return "ts";
    case "js":
    case "javascript":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "py":
    case "python":
      return "python";
    case "go":
    case "golang":
      return "go";
    case "java":
      return "java";
    case "c":
      return "c";
    case "c++":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "h":
      return "cpp";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
      return "html";
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "sql":
      return "sql";
    case "sh":
    case "bash":
    case "zsh":
    case "shell":
      return "bash";
    case "md":
    case "markdown":
      return "md";
    default:
      return null;
  }
}

export type SupportedLang =
  | "rust"
  | "ts"
  | "js"
  | "python"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "css"
  | "html"
  | "json"
  | "yaml"
  | "toml"
  | "sql"
  | "bash"
  | "md";

interface LangSpec {
  /** Patterns tried in order; first match wins for any given offset. */
  patterns: Array<{ re: RegExp; cls: string }>;
}

const KEYWORDS: Record<string, string[]> = {
  rust: [
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
    "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop",
    "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self",
    "static", "struct", "super", "trait", "true", "type", "unsafe", "use",
    "where", "while", "yield",
  ],
  ts: [
    "abstract", "any", "as", "async", "await", "boolean", "break", "case",
    "catch", "class", "const", "constructor", "continue", "debugger",
    "declare", "default", "delete", "do", "else", "enum", "export", "extends",
    "false", "finally", "for", "from", "function", "get", "if", "implements",
    "import", "in", "instanceof", "interface", "is", "keyof", "let", "module",
    "namespace", "never", "new", "null", "number", "object", "of", "package",
    "private", "protected", "public", "readonly", "require", "return", "set",
    "static", "string", "super", "switch", "symbol", "this", "throw", "true",
    "try", "type", "typeof", "undefined", "unknown", "var", "void", "while",
    "with", "yield",
  ],
  js: [
    "async", "await", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "export", "extends",
    "false", "finally", "for", "from", "function", "if", "import", "in",
    "instanceof", "let", "new", "null", "of", "return", "static", "super",
    "switch", "this", "throw", "true", "try", "typeof", "undefined", "var",
    "void", "while", "with", "yield",
  ],
  python: [
    "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "False", "finally", "for", "from",
    "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not",
    "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
  ],
  go: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
    "map", "package", "range", "return", "select", "struct", "switch", "type",
    "var",
  ],
  java: [
    "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
    "class", "const", "continue", "default", "do", "double", "else", "enum",
    "extends", "false", "final", "finally", "float", "for", "goto", "if",
    "implements", "import", "instanceof", "int", "interface", "long", "native",
    "new", "null", "package", "private", "protected", "public", "return",
    "short", "static", "strictfp", "super", "switch", "synchronized", "this",
    "throw", "throws", "transient", "true", "try", "void", "volatile", "while",
  ],
  c: [
    "auto", "break", "case", "char", "const", "continue", "default", "do",
    "double", "else", "enum", "extern", "float", "for", "goto", "if", "int",
    "long", "register", "return", "short", "signed", "sizeof", "static",
    "struct", "switch", "typedef", "union", "unsigned", "void", "volatile",
    "while",
  ],
  cpp: [
    "alignas", "alignof", "auto", "bool", "break", "case", "catch", "char",
    "class", "const", "constexpr", "continue", "default", "delete", "do",
    "double", "else", "enum", "explicit", "export", "extern", "false", "final",
    "float", "for", "friend", "goto", "if", "inline", "int", "long", "mutable",
    "namespace", "new", "noexcept", "nullptr", "operator", "override",
    "private", "protected", "public", "register", "return", "short", "signed",
    "sizeof", "static", "struct", "switch", "template", "this", "throw",
    "true", "try", "typedef", "typeid", "typename", "union", "unsigned",
    "using", "virtual", "void", "volatile", "while",
  ],
  bash: [
    "if", "then", "else", "elif", "fi", "case", "esac", "for", "select",
    "while", "until", "do", "done", "in", "function", "return", "exit",
    "break", "continue", "local", "export", "readonly", "declare", "unset",
    "echo", "printf", "set", "shift", "test",
  ],
  sql: [
    "select", "from", "where", "and", "or", "not", "in", "is", "null", "as",
    "join", "left", "right", "inner", "outer", "on", "group", "by", "having",
    "order", "asc", "desc", "limit", "offset", "insert", "into", "values",
    "update", "set", "delete", "create", "table", "index", "drop", "alter",
    "view", "primary", "key", "foreign", "references", "constraint", "unique",
    "default", "case", "when", "then", "else", "end", "with", "union", "all",
  ],
};

function kwRegex(words: string[]): RegExp {
  return new RegExp(`\\b(?:${words.join("|")})\\b`);
}

/** Common code patterns that appear across most languages. */
const CSTYLE: Array<{ re: RegExp; cls: string }> = [
  { re: /\/\/.*?(?=\n|$)/, cls: "com" },
  { re: /\/\*[\s\S]*?\*\//, cls: "com" },
  { re: /"(?:\\.|[^"\\\n])*"/, cls: "str" },
  { re: /'(?:\\.|[^'\\\n])*'/, cls: "str" },
  { re: /`(?:\\.|[^`\\])*`/, cls: "str" },
  { re: /\b0x[0-9a-fA-F_]+\b/, cls: "num" },
  { re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, cls: "num" },
  { re: /\b[A-Z][A-Za-z0-9_]*\b/, cls: "typ" },
  { re: /\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/, cls: "fn" },
];

const SPECS: Record<SupportedLang, LangSpec> = {
  rust: {
    patterns: [
      ...CSTYLE,
      { re: kwRegex(KEYWORDS.rust), cls: "kw" },
      { re: /[{}()\[\];,.:<>=+\-*/%&|!?]/, cls: "pun" },
    ],
  },
  ts: {
    patterns: [
      ...CSTYLE,
      { re: kwRegex(KEYWORDS.ts), cls: "kw" },
      { re: /[{}()\[\];,.:<>=+\-*/%&|!?]/, cls: "pun" },
    ],
  },
  js: {
    patterns: [
      ...CSTYLE,
      { re: kwRegex(KEYWORDS.js), cls: "kw" },
      { re: /[{}()\[\];,.:<>=+\-*/%&|!?]/, cls: "pun" },
    ],
  },
  python: {
    patterns: [
      { re: /#.*?(?=\n|$)/, cls: "com" },
      { re: /"""[\s\S]*?"""/, cls: "str" },
      { re: /'''[\s\S]*?'''/, cls: "str" },
      { re: /"(?:\\.|[^"\\\n])*"/, cls: "str" },
      { re: /'(?:\\.|[^'\\\n])*'/, cls: "str" },
      { re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, cls: "num" },
      { re: /\b[A-Z][A-Za-z0-9_]*\b/, cls: "typ" },
      { re: /\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/, cls: "fn" },
      { re: kwRegex(KEYWORDS.python), cls: "kw" },
      { re: /[{}()\[\];,.:<>=+\-*/%&|!?]/, cls: "pun" },
    ],
  },
  go: {
    patterns: [
      ...CSTYLE,
      { re: kwRegex(KEYWORDS.go), cls: "kw" },
      { re: /[{}()\[\];,.:<>=+\-*/%&|!?]/, cls: "pun" },
    ],
  },
  java: {
    patterns: [
      ...CSTYLE,
      { re: kwRegex(KEYWORDS.java), cls: "kw" },
      { re: /[{}()\[\];,.:<>=+\-*/%&|!?]/, cls: "pun" },
    ],
  },
  c: {
    patterns: [
      ...CSTYLE,
      { re: kwRegex(KEYWORDS.c), cls: "kw" },
      { re: /^\s*#\s*\w+.*?(?=\n|$)/m, cls: "com" }, // preprocessor
      { re: /[{}()\[\];,.:<>=+\-*/%&|!?]/, cls: "pun" },
    ],
  },
  cpp: {
    patterns: [
      ...CSTYLE,
      { re: kwRegex(KEYWORDS.cpp), cls: "kw" },
      { re: /^\s*#\s*\w+.*?(?=\n|$)/m, cls: "com" },
      { re: /[{}()\[\];,.:<>=+\-*/%&|!?]/, cls: "pun" },
    ],
  },
  css: {
    patterns: [
      { re: /\/\*[\s\S]*?\*\//, cls: "com" },
      { re: /"(?:\\.|[^"\\\n])*"/, cls: "str" },
      { re: /'(?:\\.|[^'\\\n])*'/, cls: "str" },
      { re: /[.#][a-zA-Z][\w-]*/, cls: "typ" },
      { re: /\b[a-zA-Z-]+(?=\s*:)/, cls: "kw" },
      { re: /#[0-9a-fA-F]{3,8}\b/, cls: "num" },
      { re: /\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b/, cls: "num" },
      { re: /[{};:,()]/, cls: "pun" },
    ],
  },
  html: {
    patterns: [
      { re: /<!--[\s\S]*?-->/, cls: "com" },
      { re: /"(?:\\.|[^"\\\n])*"/, cls: "str" },
      { re: /'(?:\\.|[^'\\\n])*'/, cls: "str" },
      { re: /<\/?[a-zA-Z][\w-]*/, cls: "kw" },
      { re: /\b[a-zA-Z-]+(?==)/, cls: "fn" },
      { re: /[<>=/]/, cls: "pun" },
    ],
  },
  json: {
    patterns: [
      { re: /"(?:\\.|[^"\\\n])*"(?=\s*:)/, cls: "kw" },
      { re: /"(?:\\.|[^"\\\n])*"/, cls: "str" },
      { re: /\b(?:true|false|null)\b/, cls: "typ" },
      { re: /-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, cls: "num" },
      { re: /[{}\[\],:]/, cls: "pun" },
    ],
  },
  yaml: {
    patterns: [
      { re: /#.*?(?=\n|$)/, cls: "com" },
      { re: /^\s*-?\s*[A-Za-z_][\w-]*(?=\s*:)/m, cls: "kw" },
      { re: /"(?:\\.|[^"\\\n])*"/, cls: "str" },
      { re: /'(?:\\.|[^'\\\n])*'/, cls: "str" },
      { re: /\b(?:true|false|null|yes|no)\b/, cls: "typ" },
      { re: /-?\b\d[\d_]*(?:\.\d+)?\b/, cls: "num" },
      { re: /[{}\[\]\-:,]/, cls: "pun" },
    ],
  },
  toml: {
    patterns: [
      { re: /#.*?(?=\n|$)/, cls: "com" },
      { re: /^\s*\[[^\]]+\]/m, cls: "typ" },
      { re: /"(?:\\.|[^"\\\n])*"/, cls: "str" },
      { re: /'(?:\\.|[^'\\\n])*'/, cls: "str" },
      { re: /\b(?:true|false)\b/, cls: "typ" },
      { re: /-?\b\d[\d_]*(?:\.\d+)?\b/, cls: "num" },
      { re: /^\s*[A-Za-z_][\w-]*(?=\s*=)/m, cls: "kw" },
      { re: /[\[\]=,]/, cls: "pun" },
    ],
  },
  sql: {
    patterns: [
      { re: /--.*?(?=\n|$)/, cls: "com" },
      { re: /\/\*[\s\S]*?\*\//, cls: "com" },
      { re: /"(?:\\.|[^"\\\n])*"/, cls: "str" },
      { re: /'(?:\\.|[^'\\\n])*'/, cls: "str" },
      { re: new RegExp(`\\b(?:${KEYWORDS.sql.join("|")})\\b`, "i"), cls: "kw" },
      { re: /-?\b\d[\d_]*(?:\.\d+)?\b/, cls: "num" },
      { re: /[(),;.*]/, cls: "pun" },
    ],
  },
  bash: {
    patterns: [
      { re: /#.*?(?=\n|$)/, cls: "com" },
      { re: /"(?:\\.|[^"\\])*"/, cls: "str" },
      { re: /'[^']*'/, cls: "str" },
      { re: /\$\{[^}]+\}/, cls: "typ" },
      { re: /\$[A-Za-z_][\w]*/, cls: "typ" },
      { re: kwRegex(KEYWORDS.bash), cls: "kw" },
      { re: /[\[\]\{\};|&<>()=]/, cls: "pun" },
    ],
  },
  md: {
    patterns: [
      { re: /^#{1,6}\s.*?(?=\n|$)/m, cls: "kw" },
      { re: /\*\*[^*]+\*\*/, cls: "typ" },
      { re: /`[^`]+`/, cls: "str" },
      { re: /\[[^\]]+\]\([^)]+\)/, cls: "fn" },
      { re: /^\s*[-*+]\s/m, cls: "pun" },
    ],
  },
};

/**
 * Tokenise `text` according to `lang`. The tokenisation is greedy
 * left-to-right: at each position we try every pattern and keep the
 * one with the lowest start-of-match index, falling back to a single
 * plain-text character when no pattern matches.
 *
 * Returns an array of `{ text, cls }` segments — `cls === ""` for
 * plain text. Callers wrap each segment in a span; line breaks are
 * preserved verbatim.
 */
export function tokenize(text: string, lang: SupportedLang): Token[] {
  const spec = SPECS[lang];
  const out: Token[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let bestIdx = -1;
    let bestLen = 0;
    let bestCls = "";
    for (const { re, cls } of spec.patterns) {
      // Anchor each regex to the current cursor by using `re.lastIndex`-
      // style matching via `slice` (the source patterns are not sticky;
      // creating a new `RegExp` per call would be needlessly expensive).
      const match = text.slice(cursor).match(re);
      if (!match || match.index === undefined) continue;
      const idx = cursor + match.index;
      if (
        bestIdx === -1 ||
        idx < bestIdx ||
        (idx === bestIdx && match[0].length > bestLen)
      ) {
        bestIdx = idx;
        bestLen = match[0].length;
        bestCls = cls;
      }
    }
    if (bestIdx === -1) {
      out.push({ text: text.slice(cursor), cls: "" });
      break;
    }
    if (bestIdx > cursor) {
      out.push({ text: text.slice(cursor, bestIdx), cls: "" });
    }
    out.push({ text: text.slice(bestIdx, bestIdx + bestLen), cls: bestCls });
    cursor = bestIdx + bestLen;
  }
  return out;
}

/**
 * Render `text` to an array of tokens. If `lang` is empty / unknown,
 * returns one plain-text token so the caller can render the snippet
 * unstyled without a special case.
 */
export function highlight(text: string, lang?: string | null): Token[] {
  const normalised = normaliseLanguage(lang);
  if (!normalised) return [{ text, cls: "" }];
  return tokenize(text, normalised);
}
