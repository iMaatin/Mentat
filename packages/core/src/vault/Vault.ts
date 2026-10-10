/**
 * Identifier tokenization.
 *
 * Every proprietary identifier in the real repository is mapped to a stable,
 * structurally-neutral token. Tokens are reversible: given the same vault, the
 * cloud model's output can be mapped back to the real names exactly.
 *
 * Design rules:
 * - Tokens use a reserved prefix (`zq_`) so they can never collide with a real
 *   identifier that survived sanitization.
 * - Tokens are deterministic given the vault. Re-running Mentat on the same
 *   repo yields the same tokens, which keeps diffs stable across jobs.
 * - Tokens encode *kind* (`mod`, `fn`, `tbl`, ...) but never the original text.
 *   Kind is useful context for the cloud model and leaks nothing.
 */

export type IdentifierKind =
  | "mod"
  | "fn"
  | "cls"
  | "var"
  | "tbl"
  | "col"
  | "env"
  | "key"
  | "org"
  | "path"
  | "misc";

/** Reserved prefix for every token Mentat emits. */
export const TOKEN_PREFIX = "zq_";

export interface VaultEntry {
  /** The real, proprietary identifier. Never leaves the machine. */
  readonly real: string;
  /** The token handed to the cloud model. */
  readonly token: string;
  readonly kind: IdentifierKind;
  /** How the entry was discovered, for auditing and report output. */
  readonly source: "code" | "data" | "path" | "config" | "text" | "manual";
  /** Original case shape, so reverse mapping can restore casing conventions. */
  readonly shape: IdentifierShape;
}

export type IdentifierShape = "snake" | "camel" | "pascal" | "kebab" | "upper" | "flat";

const SHAPE_PATTERNS: ReadonlyArray<readonly [IdentifierShape, RegExp]> = [
  ["upper", /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/],
  ["snake", /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/],
  ["kebab", /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/],
  ["pascal", /^[A-Z][a-zA-Z0-9]*$/],
  ["camel", /^[a-z][a-zA-Z0-9]*$/],
  ["upper", /^[A-Z][A-Z0-9]*$/],
];

export function detectShape(identifier: string): IdentifierShape {
  for (const [shape, pattern] of SHAPE_PATTERNS) if (pattern.test(identifier)) return shape;
  return "flat";
}

/** Words that carry no proprietary signal and are safe to pass through as-is. */
const STOPWORDS = new Set([
  "app", "api", "auth", "base", "batch", "bool", "buffer", "build", "cache", "cancel", "cfg",
  "channel", "char", "class", "client", "cmd", "code", "col", "config", "const", "core", "count",
  "ctx", "data", "date", "day", "db", "def", "delta", "desc", "dict", "dir", "dispatch", "done",
  "dst", "elapsed", "err", "error", "event", "exec", "exit", "ext", "fail", "false", "field",
  "file", "filter", "final", "flag", "fmt", "for", "format", "from", "func", "get", "group",
  "handler", "hash", "id", "idx", "in", "index", "init", "input", "int", "is", "item", "iter",
  "json", "key", "len", "limit", "line", "list", "load", "log", "loop", "map", "max", "mem",
  "merge", "meta", "method", "min", "msg", "name", "next", "node", "null", "num", "obj",
  "offset", "op", "opt", "order", "out", "output", "page", "param", "parser", "parts", "path",
  "payload", "pending", "pid", "pkg", "pool", "port", "pos", "prev", "proc", "query", "queue",
  "range", "rate", "raw", "read", "rec", "record", "ref", "req", "res", "result", "retry",
  "return", "row", "rows", "run", "save", "schema", "score", "search", "seq", "session",
  "set", "size", "sort", "src", "start", "state", "status", "step", "stop", "str", "stream",
  "string", "sub", "sum", "sync", "table", "target", "task", "temp", "test", "text", "then",
  "time", "timestamp", "to", "token", "total", "tmp", "true", "type", "un", "update", "url",
  "use", "user", "val", "value", "var", "version", "wait", "warn", "where", "while", "with",
  "work", "worker", "write", "year",
]);

/**
 * Identifiers that are too generic to be worth tokenizing. Tokenizing these
 * wastes tokens and actively hurts the cloud model, which reads the surrounding
 * code far better when common names stay readable.
 */
export function isStopword(identifier: string): boolean {
  const lower = identifier.toLowerCase();
  if (STOPWORDS.has(lower)) return true;
  // Short all-lowercase tokens carry no signal and are often loop variables.
  if (identifier.length <= 2 && /^[a-z]+$/.test(identifier)) return true;
  return false;
}

/** Common-language words that should also survive sanitization untouched. */
export class Vault {
  private readonly forward = new Map<string, VaultEntry>();
  private readonly reverse = new Map<string, VaultEntry>();
  private readonly counters = new Map<IdentifierKind, number>();

  constructor(entries: readonly VaultEntry[] = []) {
    for (const entry of entries) this.load(entry);
  }

  load(entry: VaultEntry): void {
    this.forward.set(entry.real, entry);
    this.reverse.set(entry.token, entry);
    const n = parseCounter(entry.token);
    if (n !== undefined) {
      const current = this.counters.get(entry.kind) ?? 0;
      if (n > current) this.counters.set(entry.kind, n);
    }
  }

  has(real: string): boolean {
    return this.forward.has(real);
  }

  lookup(real: string): VaultEntry | undefined {
    return this.forward.get(real);
  }

  unlookup(token: string): VaultEntry | undefined {
    return this.reverse.get(token);
  }

  get size(): number {
    return this.forward.size;
  }

  /**
   * Returns the token for `real`, minting one on first sight. `hint` supplies a
   * non-proprietary stem derived from the identifier's own words (e.g. an
   * abbreviation); it is never the original text.
   */
  tokenize(real: string, kind: IdentifierKind, source: VaultEntry["source"], hint?: string): VaultEntry {
    const existing = this.forward.get(real);
    if (existing) return existing;

    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const stem = sanitizeStem(hint) ?? kind;
    const entry: VaultEntry = {
      real,
      token: `${TOKEN_PREFIX}${kind}_${stem}_${pad(n)}`,
      kind,
      source,
      shape: detectShape(real),
    };
    this.forward.set(real, entry);
    this.reverse.set(entry.token, entry);
    return entry;
  }

  /**
 * Replaces every real identifier with its token.
 *
 * Entries are applied longest-first with word boundaries. Order matters: a
 * short name that is a prefix of a longer one (`acme_billing` inside
 * `acme_billing_ledger`) would otherwise be substituted first and shred the
 * longer name into a token plus a stray suffix, which then gets tokenized again
 * on the next pass and corrupts the vault.
 *
 * Existing tokens are left untouched for the same reason: re-processing a token
 * is how a vault starts mapping tokens to other tokens.
 */
sanitize(text: string): string {
  let out = text;
  for (const entry of this.byLength) {
    out = replaceIdentifier(out, entry.real, entry.token, false);
  }
  return out;
}

/** The only method permitted to reach real names. Used by layer 3. */
restore(text: string): string {
  let out = text;
  for (const entry of this.byLength) {
    out = replaceIdentifier(out, entry.token, entry.real, true);
  }
  return out;
}

/** Entries ordered longest first, recomputed whenever the vault changes. */
private cachedByLength: readonly VaultEntry[] = [];

private get byLength(): readonly VaultEntry[] {
  if (this.cachedByLength.length !== this.forward.size) {
    this.cachedByLength = [...this.forward.values()].sort((a, b) => b.real.length - a.real.length);
  }
  return this.cachedByLength;
}

entries(): VaultEntry[] {
  return [...this.forward.values()].sort((a, b) => a.token.localeCompare(b.token));
}

  byKind(kind: IdentifierKind): VaultEntry[] {
    return this.entries().filter((e) => e.kind === kind);
  }

  toJSON(): VaultEntry[] {
    return this.entries();
  }
}

function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

/** Matches an identifier only when not embedded in a longer identifier. */
const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * Replaces one identifier, respecting word boundaries and never touching text
 * that is already a Mentat token.
 *
 * Two invariants matter here:
 *
 *  - Boundaries. `acme_billing` must not be substituted inside
 *    `acme_billing_ledger`; the longer name is handled first and the shorter
 *    one then matches nothing.
 *  - Tokens are inert. Once text contains `zq_*`, it is already sanitized.
 *    Rewriting it again is how a vault ends up mapping one token to another,
 *    which silently breaks layer 3 for every identifier after the first.
 */
function replaceIdentifier(text: string, needle: string, replacement: string, isRestore: boolean): string {
  if (text.length === 0 || needle.length === 0) return text;

  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(needle, i);
    if (at === -1) {
      out += text.slice(i);
      break;
    }

    const before = at > 0 ? (text[at - 1] as string) : "";
    const after = text[at + needle.length];
    const boundaryOk =
      (before === "" || !IDENT_CHAR.test(before)) &&
      (after === undefined || !IDENT_CHAR.test(after));

    // Only the sanitize direction needs the token guard. On the restore path
    // the needle *is* the token, so blocking it would make restore a no-op.
    const insideToken = !isRestore && insideExistingToken(text, at);

    if (!boundaryOk || insideToken) {
      out += text.slice(i, at + needle.length);
      i = at + needle.length;
      continue;
    }

    out += text.slice(i, at) + replacement;
    i = at + needle.length;
  }
  return out;
}

/** True when the text immediately before `at` is inside a `zq_` token. */
function insideExistingToken(text: string, at: number): boolean {
  const start = text.lastIndexOf(TOKEN_PREFIX, at);
  if (start === -1) return false;
  // A token is `zq_` followed by identifier characters. If an identifier
  // character separates the prefix from `at`, this is not a token we emitted.
  for (let k = start + TOKEN_PREFIX.length; k < at; k++) {
    if (!IDENT_CHAR.test(text[k] as string)) return false;
  }
  return at - start <= 40;
}

function parseCounter(token: string): number | undefined {
  const match = /_(\d+)$/.exec(token);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

function sanitizeStem(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const cleaned = hint.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned || cleaned.length < 3 || cleaned.length > 24) return undefined;
  if (isStopword(cleaned)) return undefined;
  return cleaned;
}