/**
 * Language-aware source sanitization.
 *
 * Replaces proprietary identifiers with vault tokens while preserving the file's
 * structure exactly: whitespace, operators, line numbers, and comment markers
 * all survive, so a diff against the mock is a clean textual substitution and
 * layer 3 can reverse it mechanically.
 *
 * The scanner in `scan.ts` is the safety net; this module is what makes the
 * payload *useful* to the cloud model. Both are required.
 */

import { Vault, TOKEN_PREFIX, type IdentifierKind } from "../vault/Vault.js";

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "sql"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "shell"
  | "yaml"
  | "json"
  | "markdown"
  | "text";

const EXTENSION_LANGUAGE: Readonly<Record<string, Language>> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".sql": "sql",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".sh": "shell", ".bash": "shell",
  ".yml": "yaml", ".yaml": "yaml",
  ".json": "json", ".jsonc": "json",
  ".md": "markdown", ".markdown": "markdown",
};

export function languageFor(path: string): Language {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "text";
  return EXTENSION_LANGUAGE[path.slice(dot).toLowerCase()] ?? "text";
}

interface LexRule {
  readonly language: readonly Language[];
  /** Matches one comment and captures whether it is a line comment. */
  readonly pattern: RegExp;
}

const LINE_COMMENT = /(\/\/[^\n]*|#[^\n]*|--[^\n]*)/;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//;
const HASH_COMMENT = /##[^\n]*/;

const DOUBLE_QUOTED = /"(?:\\.|[^"\\])*"/;
const SINGLE_QUOTED = /'(?:\\.|[^'\\])*'/;
const BACKTICK = /`(?:\\.|[^`\\])*`/;
const TRIPLE_QUOTED = /(?:'''|""")[\s\S]*?(?:'''|""")/;

/**
 * Comment and string syntax per language family. Applied as an ordered pass so
 * that a `#` inside a Python string is never mistaken for a comment.
 */
const COMMENT_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  hash: [LINE_COMMENT],
  hash2: [LINE_COMMENT, HASH_COMMENT],
  cstyle: [LINE_COMMENT, BLOCK_COMMENT],
};

const STRING_PATTERNS: readonly RegExp[] = [TRIPLE_QUOTED, BACKTICK, DOUBLE_QUOTED, SINGLE_QUOTED];

interface CommentStyle {
  readonly line: RegExp;
  readonly block?: readonly RegExp[];
  readonly linePrefix?: string;
}

const COMMENT_STYLE: Readonly<Partial<Record<Language, CommentStyle>>> = {
  typescript: { line: /\/\/[^\n]*/, block: [/\/\*[\s\S]*?\*\//] },
  javascript: { line: /\/\/[^\n]*/, block: [/\/\*[\s\S]*?\*\//] },
  go: { line: /\/\/[^\n]*/, block: [/\/\*[\s\S]*?\*\//] },
  rust: { line: /\/\/[^\n]*/, block: [/\/\*[\s\S]*?\*\//] },
  java: { line: /\/\/[^\n]*/, block: [/\/\*[\s\S]*?\*\//] },
  csharp: { line: /\/\/[^\n]*/, block: [/\/\*[\s\S]*?\*\//] },
  python: { line: /#[^\n]*/ },
  sql: { line: /--[^\n]*/, block: [/\/\*[\s\S]*?\*\//] },
  shell: { line: /#[^\n]*/ },
  yaml: { line: /#[^\n]*/ },
};

export interface Segment {
  readonly kind: "code" | "string" | "comment";
  readonly text: string;
  readonly start: number;
}

/** Splits source into code, string, and comment segments. Order is preserved. */
export function segment(source: string, language: Language): Segment[] {
  const style = COMMENT_STYLE[language];
  const segments: Segment[] = [];
  let pos = 0;
  let codeStart = 0;

  const pushCode = (end: number) => {
    if (end > codeStart) segments.push({ kind: "code", text: source.slice(codeStart, end), start: codeStart });
  };

  while (pos < source.length) {
    let matched = false;

    for (const pattern of STRING_PATTERNS) {
      const m = pattern.exec(source.slice(pos));
      if (m && m.index === 0 && m[0].length > 0) {
        pushCode(pos);
        segments.push({ kind: "string", text: m[0], start: pos });
        pos += m[0].length;
        codeStart = pos;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (style) {
      for (const pattern of [style.line, ...(style.block ?? [])]) {
        const m = pattern.exec(source.slice(pos));
        if (m && m.index === 0 && m[0].length > 0) {
          pushCode(pos);
          segments.push({ kind: "comment", text: m[0], start: pos });
          pos += m[0].length;
          codeStart = pos;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    pos += 1;
  }

  pushCode(source.length);
  return segments;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Words that must never be tokenized even in code position. */
const RESERVED = new Set([
  "if", "else", "for", "while", "return", "function", "class", "const", "let", "var",
  "import", "export", "from", "as", "default", "new", "this", "super", "self",
  "def", "lambda", "pass", "raise", "try", "except", "finally", "with", "yield",
  "async", "await", "static", "public", "private", "protected", "void", "int", "str",
  "bool", "float", "list", "dict", "set", "tuple", "true", "false", "null", "nil",
  "select", "from", "where", "group", "order", "by", "join", "left", "right", "inner",
  "outer", "on", "as", "and", "or", "not", "in", "is", "case", "when", "then", "end",
  "begin", "commit", "rollback", "create", "table", "index", "view", "insert", "update",
  "delete", "into", "values", "primary", "key", "foreign", "references", "distinct",
  "func", "fn", "match", "use", "mod", "pub", "mut", "ref", "impl", "trait", "struct",
  "enum", "interface", "type", "package", "namespace", "template", "typename", "operator",
]);



export interface SanitizeOptions {
  /**
   * Rewrite identifiers and secrets found inside string literals.
   *
   * On by default. Deferring this entirely to the local model left a real leak:
   * with the model disabled or unavailable, a docstring mentioning the company
   * name or an internal address would pass through untouched and be read by the
   * cloud model. The model improves readability; it is not the safety net.
   */
  readonly tokenizeStrings?: boolean;
  /** Same, for comments. On by default. */
  readonly tokenizeComments?: boolean;
  /** Extra terms that must be tokenized regardless of the heuristics. */
  readonly forcedTerms?: readonly string[];
}

export interface SanitizeResult {
  readonly text: string;
  readonly tokensIntroduced: number;
}

/**
 * Identifiers that must never be tokenized: language builtins and the API
 * surface of the most common standard-library and third-party packages.
 *
 * Tokenizing these does not merely lose information, it produces code that no
 * longer parses or runs. `from dataclasses import dataclass` becoming
 * `from zq_var_var_001 import zq_var_var_002` yields a mock the cloud model
 * cannot reason about, which defeats the entire exercise.
 */
const PROTECTED = new Set([
  // Python builtins
  "abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes", "callable", "chr",
  "classmethod", "compile", "complex", "delattr", "dict", "dir", "divmod", "enumerate",
  "eval", "exec", "filter", "float", "format", "frozenset", "getattr", "globals", "hasattr",
  "hash", "hex", "id", "input", "int", "isinstance", "issubclass", "iter", "len", "list",
  "locals", "map", "max", "memoryview", "min", "next", "object", "oct", "open", "ord",
  "pow", "print", "property", "range", "repr", "reversed", "round", "set", "setattr",
  "slice", "sorted", "staticmethod", "str", "sum", "super", "tuple", "type", "vars", "zip",
  "self", "cls", "__init__", "__name__", "__main__", "__repr__", "__str__", "__enter__",
  "__exit__", "__iter__", "__next__", "__len__", "__eq__", "__hash__", "__call__",
  // exceptions
  "Exception", "ValueError", "TypeError", "KeyError", "IndexError", "RuntimeError",
  "AttributeError", "NotImplementedError", "StopIteration", "ZeroDivisionError",
  // Python stdlib modules
  "abc", "argparse", "asyncio", "base64", "collections", "contextlib", "copy", "csv",
  "dataclasses", "datetime", "decimal", "enum", "functools", "glob", "hashlib", "io",
  "itertools", "json", "logging", "math", "os", "pathlib", "pickle", "random", "re",
  "shutil", "sqlite3", "statistics", "string", "subprocess", "sys", "tempfile", "textwrap",
  "threading", "time", "traceback", "typing", "unittest", "urllib", "uuid", "warnings",
  // common scientific/data APIs
  "pandas", "numpy", "np", "pd", "pyarrow", "duckdb", "matplotlib", "seaborn", "sklearn",
  "read_csv", "read_parquet", "read_json", "read_excel", "to_csv", "to_parquet", "to_json",
  "to_excel", "DataFrame", "Series", "groupby", "merge", "concat", "isin", "notna", "isna",
  "fillna", "dropna", "drop_duplicates", "reset_index", "set_index", "sort_values",
  "value_counts", "apply", "astype", "describe", "head", "tail", "sum", "mean", "median",
  "std", "var", "min", "max", "count", "nunique", "loc", "iloc", "iloc", "assign",
  "np", "array", "arange", "zeros", "ones", "concatenate", "where", "sqrt", "log", "exp",
  // JS/TS
  "console", "document", "window", "Promise", "Array", "Object", "String", "Number",
  "Boolean", "Symbol", "Map", "Set", "WeakMap", "JSON", "Math", "Date", "RegExp", "Error",
  "fetch", "require", "module", "exports", "process", "Buffer", "globalThis", "undefined",
  // infra / protocols
  "http", "https", "grpc", "grpcClient", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD",
]);

/**
 * Language keywords and literals, matched case-insensitively.
 *
 * These must survive tokenization or the sandbox will not parse. Python's
 * `True` becoming `zq_cls_cls_002` turns `assert True` into a NameError, which
 * means the cloud model is handed a test suite that cannot possibly run.
 */
const LANGUAGE_KEYWORDS = new Set([
  "if", "else", "elif", "for", "while", "switch", "case", "default", "break", "continue",
  "return", "yield", "await", "async", "def", "class", "lambda", "pass", "raise", "throw",
  "try", "except", "finally", "catch", "with", "as", "from", "import", "export", "global",
  "nonlocal", "assert", "del", "not", "and", "or", "is", "in", "match", "typeof", "instanceof",
  "void", "this", "super", "extends", "implements", "interface", "enum", "struct", "trait",
  "impl", "pub", "mut", "ref", "unsafe", "fn", "use", "mod", "package", "namespace",
  "true", "false", "null", "none", "nil", "nan", "inf", "infinity", "undefined", "true", "self",
  "operator", "where", "select", "from", "group", "order", "by", "join", "on", "using",
]);

/**
 * Collects names bound by import statements plus the members reached through
 * them, so `pd.read_parquet` is recognised as library surface rather than a
 * proprietary function.
 */
function collectProtected(source: string, language: Language): Set<string> {
  const names = new Set<string>();
  if (language === "python") {
    const fromImport = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/gm;
    let m = fromImport.exec(source);
    while (m !== null) {
      const clause = m[2] ?? "";
      for (const part of clause.split(",")) {
        const alias = part.trim().split(/\s+as\s+/i).pop()?.trim();
        if (alias) names.add(alias.replace(/[()]/g, ""));
      }
      m = fromImport.exec(source);
    }
    const plainImport = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)$/gm;
    m = plainImport.exec(source);
    while (m !== null) {
      for (const part of (m[1] ?? "").split(",")) {
        const base = part.trim().split(".")[0];
        if (base) names.add(base);
      }
      m = plainImport.exec(source);
    }
  }

  // Any member reached through an imported alias or `self`/`this` belongs to
  // that library or class, not to the user.
  if (names.size > 0 || language !== "python") {
    const receivers = new Set(["self", "this", ...names]);
    const member = /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g;
    let mm = member.exec(source);
    while (mm !== null) {
      if (receivers.has(mm[1] as string)) {
        const attr = mm[2];
        if (attr) names.add(attr);
      }
      mm = member.exec(source);
    }
  }
  return names;
}

/**
 * Tokens that look like code references or product names when they appear
 * inside prose.
 *
 * A snake_case or CONSTANT_CASE token inside a docstring is almost always a
 * reference to something in the code, and is exactly the kind of term that
 * identifies an internal system. A PascalCase token in prose is usually a
 * product or company name ("AcmeCorp", "InternalLedger"), which leaks just as
 * effectively. Both shapes are replaced unless they are known library surface.
 */
const PROSE_CODE_REF =
  /\b(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z]+[A-Z][A-Za-z0-9]*)\b/g;

const EMAIL_IN_LITERAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IP_IN_LITERAL = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URL_IN_LITERAL = /\b(?:https?|ftp):\/\/[^\s"'`<>]+/gi;

/**
 * Rewrites `source` with vault tokens. Structural output is byte-identical to
 * the input apart from identifier substitutions.
 */
export function sanitizeSource(
  source: string,
  language: Language,
  vault: Vault,
  options: SanitizeOptions = {},
): SanitizeResult {
  const before = vault.size;
  const forced = new Set(options.forcedTerms ?? []);
  const protectedNames = collectProtected(source, language);
  const doStrings = options.tokenizeStrings ?? true;
  const doComments = options.tokenizeComments ?? true;

  const kindFor = (name: string, isCall: boolean): IdentifierKind => {
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) return "key";
    if (isCall) return "fn";
    if (/^[A-Z]/.test(name)) return "cls";
    if (language === "sql" && name === name.toLowerCase() && /^[a-z]+(_[a-z0-9]+)+$/.test(name)) return "tbl";
    return "var";
  };

  const shouldTokenize = (name: string, isCall: boolean): boolean => {
    if (forced.has(name)) return true;
    // Already sanitized. Tokenizing a token is how a vault starts mapping
    // tokens to other tokens, which silently breaks layer 3.
    if (name.startsWith(TOKEN_PREFIX)) return false;
    if (RESERVED.has(name)) return false;
    if (PROTECTED.has(name.toLowerCase()) || protectedNames.has(name)) return false;
    if (LANGUAGE_KEYWORDS.has(name.toLowerCase())) return false;
    if (name.length < 3) return false;
    if (vault.has(name)) return true;
    // Every word is generic vocabulary: `parseConfig`, `handleRequest`.
    if (isFullyGeneric(name)) return false;
    if (isCommonWord(name)) return false;
    if (/^[a-z0-9]+$/.test(name) && name.length <= 4) return false;
    return isCall || /[A-Z]/.test(name) || /_/.test(name) || name.length >= 8;
  };

  const segments = segment(source, language);
  let out = "";
  for (const seg of segments) {
    if (seg.kind === "code") {
      out += tokenizeIdentifiers(seg.text, shouldTokenize, kindFor, vault);
      continue;
    }
    if (seg.kind === "comment" && doComments) {
      // Comments get the same identifier pass as code *before* the prose scrub.
      // Without it, an identifier that appears only in comments is never
      // discovered: the vault has no entry for it, so the scrub replaces
      // nothing, the mirror keeps the real name, and the moment that name
      // reaches an outbound payload the vault-literal scanner blocks an
      // otherwise-clean run. Comments are safe to tokenize fully because they
      // cannot affect the mirror's runtime behaviour, unlike string literals,
      // which may hold real data values and are only scrubbed.
      const tokenized = tokenizeIdentifiers(seg.text, shouldTokenize, kindFor, vault);
      out += scrubLiteral(tokenized, language, vault, forced);
      continue;
    }
    if (seg.kind === "string" && doStrings) {
      out += scrubLiteral(seg.text, language, vault, forced);
      continue;
    }
    out += seg.text;
  }

  return { text: out, tokensIntroduced: vault.size - before };
}

/**
 * Sanitizes a prose-only file: Markdown, YAML, TOML, and other formats that
 * carry no code structure to preserve.
 *
 * Without this, a README is mirrored verbatim and hands the cloud model the
 * company name, a maintainer's address, and an internal IP. Running these
 * files through {@link sanitizeSource} instead would tokenize identifiers but
 * leave bare values such as addresses and emails untouched.
 */
export function scrubProse(text: string, vault: Vault, options: SanitizeOptions = {}): SanitizeResult {
  const before = vault.size;
  const forced = new Set(options.forcedTerms ?? []);
  return { text: scrubLiteral(text, "text", vault, forced), tokensIntroduced: vault.size - before };
}

/**
 * Sanitizes a string literal or comment.
 *
 * Order matters: vault terms are replaced first, because the vault is the
 * authoritative list of real identifiers. Structural secrets are replaced next.
 * Only then are prose code references tokenized, which introduces new vault
 * entries that the earlier passes would not have caught.
 */
function scrubLiteral(
  text: string,
  language: Language,
  vault: Vault,
  forced: ReadonlySet<string>,
): string {
  let out = text;

  // 1. Known real identifiers and forced terms.
  for (const term of forced) out = out.split(term).join(vault.tokenize(term, "org", "text").token);
  out = vault.sanitize(out);

  // 2. Structural secrets. These are replaced outright rather than tokenized,
  //    because a token in place of a credential would still be a credential.
  out = out.replace(URL_IN_LITERAL, "https://example.invalid/resource");
  out = out.replace(EMAIL_IN_LITERAL, "user@example.com");
  out = out.replace(IP_IN_LITERAL, (match) =>
    // Documentation ranges, per RFC 5737.
    match.startsWith("10.") || match.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./
      ? "192.0.2.1"
      : match,
  );

  // 3. Prose code references: snake_case and CONSTANT_CASE words in a docstring
  //    or comment are references to real code, and are the main thing that
  //    identifies an internal system in otherwise innocent prose.
  if (language !== "json" && language !== "sql") {
    out = out.replace(PROSE_CODE_REF, (word) => {
      if (word.startsWith(TOKEN_PREFIX)) return word;
      if (PROTECTED.has(word.toLowerCase())) return word;
      if (RESERVED.has(word)) return word;
      if (LANGUAGE_KEYWORDS.has(word.toLowerCase())) return word;
      if (isFullyGeneric(word)) return word;
      return vault.tokenize(word, "org", "text").token;
    });
  }

  return out;
}

function tokenizeIdentifiers(
  text: string,
  should: (name: string, isCall: boolean) => boolean,
  kindFor: (name: string, isCall: boolean) => IdentifierKind,
  vault: Vault,
): string {
  return text.replace(IDENTIFIER, (match, offset: number, whole: string) => {
    const isCall = /^\s*\(/.test(whole.slice(offset + match.length));
    if (!should(match, isCall)) return match;
    const entry = vault.tokenize(match, kindFor(match, isCall), "code");
    return entry.token;
  });
}

const COMMON_WORDS = new Set([
  "value", "values", "index", "range", "start", "stop", "step", "total", "count", "index",
  "length", "size", "width", "height", "offset", "limit", "cursor", "page", "sort", "order",
  "filter", "select", "where", "group", "join", "table", "column", "row", "record", "field",
  "schema", "database", "connection", "session", "request", "response", "message", "event",
  "handler", "service", "manager", "worker", "client", "server", "module", "package",
  "component", "container", "context", "config", "setting", "option", "parameter", "argument",
  "return", "result", "output", "input", "source", "target", "destination", "address",
  "version", "build", "release", "debug", "trace", "metric", "measure", "report", "summary",
  "get", "set", "parse", "make", "create", "build", "read", "write", "load", "save", "send",
  "add", "remove", "delete", "update", "insert", "find", "search", "check", "validate",
  "format", "render", "convert", "transform", "encode", "decode", "extract", "compute",
  "calculate", "apply", "process", "handle", "resolve", "validate", "verify", "ensure",
]);

function isCommonWord(name: string): boolean {
  return COMMON_WORDS.has(name) || COMMON_WORDS.has(name.toLowerCase());
}

/**
 * Splits an identifier into its constituent words.
 *
 * Handles snake_case, kebab-case, and camelCase/PascalCase. `parseConfig`
 * becomes ["parse", "config"], while `acmeBillingLedger` becomes
 * ["acme", "billing", "ledger"].
 */
function splitWords(name: string): string[] {
  return name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

/**
 * Matches a column name against a list of sensitive patterns.
 *
 * Matching is by word containment, not equality. A configuration entry of
 * `email` must cover `customer_email`, `billing_email_address`, and
 * `email_2`; exact matching would silently leave the real values in the mock,
 * which is the one failure this mechanism exists to prevent.
 *
 * `*` forces a match, which is how an operator marks a column whose name shares
 * no vocabulary with the pattern list.
 */
export function isSensitiveColumn(name: string, patterns: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (p === "" ) return false;
    if (p === "*" ) return true;
    if (lower === p) return true;
    // Whole-word containment, with separators treated as word breaks.
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
    return re.test(lower) || lower.includes(p);
  });
}

/**
 * True when every word in the identifier is ordinary programming vocabulary.
 *
 * This is the check that keeps Mentat from mangling readable code. `parseConfig`
 * and `handleRequest` are made of generic words and must pass through, while
 * `acmeBillingLedger` contains a distinctive word and must be tokenized.
 * Tokenizing everything is not "safer": an over-scrubbed prompt reads as
 * nonsense and the cloud model produces worse work.
 */
function isFullyGeneric(name: string): boolean {
  const words = splitWords(name);
  if (words.length === 0) return true;
  return words.every((w) => COMMON_WORDS.has(w) || w.length <= 2);
}