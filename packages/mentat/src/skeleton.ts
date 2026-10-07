// Code skeletonizer: rename proprietary identifiers deterministically (stable
// across files via the shared vault), redact secret-shaped strings/comments,
// and truncate to a token budget. Structure, control flow, and types stay
// intact so the cloud model reasons about faithful look-alike code.

import type { StringPolicy } from "./config.js"
import type { IdentifierVault } from "./vault.js"

const GENERIC_KEYWORDS = new Set(
  "break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield async await static get new of from as implements interface package private protected public readonly abstract any boolean number string symbol bigint unknown never object undefined let using out ref params sealed override virtual partial record required init notnull nint nuint dynamic where select group by into orderby join equals on from let where and or not None True False def lambda pass raise global nonlocal assert del with as elif except import from is in not and or".split(
    /\s+/,
  ),
)

// Identifiers so generic that renaming adds noise, not privacy.
const KEEP_IDENTIFIERS = new Set(
  "id ids name names data value values item items index key keys type kind info meta config options args kwargs result results res req ctx context error err errors message msg text str num count total length size list dict map set array object obj row rows col cols column columns table field fields file files path paths dir url uri date time timestamp start end min max avg sum first last prev next curr current self cls i j k n x y v k v1 v2 tmp temp foo bar baz a b c e pi".split(
    /\s+/,
  ),
)

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g

export interface SkeletonOptions {
  strings: StringPolicy
  comments: StringPolicy
  maxLines: number
}

/** Tokens of real code, used to reserve mock names that would collide. */
export function collectIdentifierTokens(content: string): Set<string> {
  const tokens = new Set<string>()
  IDENTIFIER.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IDENTIFIER.exec(content)) !== null) {
    tokens.add(match[0])
    if (match[0].length === 0) IDENTIFIER.lastIndex++
  }
  return tokens
}

const SECRETISH_STRING =
  /(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+)/

function redactSecretsInProse(segment: string): { text: string; redacted: boolean } {
  if (!SECRETISH_STRING.test(segment)) return { text: segment, redacted: false }
  SECRETISH_STRING.lastIndex = 0
  return { text: segment.replace(SECRETISH_STRING, "[REDACTED:secret]"), redacted: true }
}

// Very small tokenizer: splits comments / strings / code for common languages.
// Good enough for redaction + elision; NOT a parser (see threat model).
export function splitSegments(content: string): { kind: "code" | "comment" | "string"; text: string }[] {
  const segments: { kind: "code" | "comment" | "string"; text: string }[] = []
  let current = ""
  let kind: "code" | "comment" | "string" = "code"
  let i = 0
  const flush = (next: typeof kind) => {
    if (current !== "") segments.push({ kind, text: current })
    current = ""
    kind = next
  }
  const pushCode = (text: string) => {
    if (kind !== "code") flush("code")
    current += text
  }
  while (i < content.length) {
    const char = content[i] as string
    const next = content[i + 1] as string
    if (kind === "code") {
      if (char === "/" && next === "/") {
        flush("comment")
        while (i < content.length && content[i] !== "\n") {
          current += content[i]
          i++
        }
        continue
      }
      if (char === "/" && next === "*") {
        flush("comment")
        current += "/*"
        i += 2
        while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
          current += content[i]
          i++
        }
        current += "*/"
        i += 2
        continue
      }
      if (char === "#") {
        // C-style `#include` / `#define` lines are code, not comments.
        let lineStart = i
        while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--
        const restOfLine = content.slice(lineStart, lineStart + 40)
        if (/^\s*#\s*(?:include|import|define|pragma|if|endif|ifdef|ifndef|elif|else|error|warning|line)\b/.test(restOfLine)) {
          pushCode(char)
          i++
          continue
        }
        flush("comment")
        while (i < content.length && content[i] !== "\n") {
          current += content[i]
          i++
        }
        continue
      }
      if (char === '"' || char === "'" || char === "`") {
        const quote = char
        flush("string")
        current += char
        i++
        while (i < content.length) {
          const inner = content[i] as string
          current += inner
          if (inner === "\\") {
            current += content[i + 1] ?? ""
            i += 2
            continue
          }
          i++
          if (inner === quote) break
          // Single-quoted strings don't span lines in most languages; bail out
          // rather than swallowing the file on an apostrophe.
          if ((quote === "'" || quote === '"') && inner === "\n") break
        }
        continue
      }
      pushCode(char)
      i++
      continue
    }
    // comment/string kinds always flush back to code after one unit above
    flush("code")
  }
  if (current !== "") segments.push({ kind, text: current })
  return segments
}

function applyProsePolicy(
  text: string,
  policy: StringPolicy,
  placeholder: string,
): { text: string; changed: boolean } {
  if (policy === "elide") {
    if (text.trim() === "") return { text, changed: false }
    return { text: placeholder, changed: true }
  }
  // Network literals are identity-bearing by construction (real hosts, real
  // mailboxes), so they normalize under every policy except elide.
  const network = redactNetworkLiterals(text)
  if (policy === "redact-secrets") {
    const { text: redacted, redacted: changed } = redactSecretsInProse(network.text)
    return { text: redacted, changed: changed || network.changed }
  }
  return { text: network.text, changed: network.changed }
}

const URL_WITH_HOST = /(https?:\/\/)([^/\s"'<>]+)/gi
const EMAIL = /([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g
const PRIVATE_IPV4 = /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"])
const APEXES = ["example.com", "example.org"] as const

function apexOf(host: string): string | undefined {
  const bare = host.toLowerCase().split(":")[0] as string
  if (LOOPBACK.has(bare)) return bare
  for (const apex of APEXES) {
    if (bare === apex || bare.endsWith(`.${apex}`)) return apex
  }
  return undefined
}

/**
 * Normalize hosts, mailboxes, and private IPs to documentation-safe values.
 * Allowlisted apexes reduce to the apex itself (`billing.x.example.com` →
 * `example.com`) so real words can never hide inside a "safe" host.
 */
export function redactNetworkLiterals(text: string): { text: string; changed: boolean } {
  let changed = false
  URL_WITH_HOST.lastIndex = 0
  let next = text.replace(URL_WITH_HOST, (_match, scheme: string, host: string) => {
    const apex = apexOf(host)
    if (apex !== undefined && host.toLowerCase() === apex) return `${scheme}${host}`
    changed = true
    return `${scheme}${apex ?? "example.com"}`
  })
  EMAIL.lastIndex = 0
  next = next.replace(EMAIL, (match: string, _local: string, domain: string) => {
    if (apexOf(domain) !== undefined) return match
    changed = true
    return "user@example.com"
  })
  PRIVATE_IPV4.lastIndex = 0
  next = next.replace(PRIVATE_IPV4, () => {
    changed = true
    return "203.0.113.1"
  })
  return { text: next, changed }
}

export interface SkeletonFile {
  realPath: string
  mockPath: string
  content: string
  renamed: number
  redactedStrings: number
  redactedComments: number
  truncatedLines: number
}

export function mockPathFor(vault: IdentifierVault, realPath: string): string {
  const parts = realPath.split("/").filter((part) => part !== "" && part !== ".")
  return parts
    .map((part, index) => {
      const isLast = index === parts.length - 1
      if (part === "..") return part
      if (isLast) {
        const dot = part.lastIndexOf(".")
        if (dot <= 0) return vault.getOrCreate("path", part)
        const stem = part.slice(0, dot)
        const ext = part.slice(dot)
        return `${vault.getOrCreate("path", stem)}${ext}`
      }
      return vault.getOrCreate("path", part)
    })
    .join("/")
}

export function skeletonizeFile(
  realPath: string,
  content: string,
  vault: IdentifierVault,
  options: SkeletonOptions,
): SkeletonFile {
  const mockPath = mockPathFor(vault, realPath)
  let renamed = 0
  let redactedStrings = 0
  let redactedComments = 0

  const segments = splitSegments(content)
  let mock = ""
  for (const segment of segments) {
    if (segment.kind === "string") {
      const quote = segment.text[0] ?? '"'
      const closer = segment.text.length > 1 && segment.text.endsWith(quote) ? quote : ""
      const inner = closer !== "" ? segment.text.slice(1, -1) : segment.text.slice(1)
      const { text, changed } = applyProsePolicy(inner, options.strings, "…")
      if (changed) redactedStrings++
      mock += `${quote}${text}${closer}`
      continue
    }
    if (segment.kind === "comment") {
      const { text, changed } = applyProsePolicy(segment.text, options.comments, "// …")
      if (changed) redactedComments++
      mock += text
      continue
    }
    IDENTIFIER.lastIndex = 0
    let replaced = ""
    let last = 0
    let match: RegExpExecArray | null
    while ((match = IDENTIFIER.exec(segment.text)) !== null) {
      const token = match[0]
      let replacement = token
      if (!GENERIC_KEYWORDS.has(token) && !KEEP_IDENTIFIERS.has(token) && token.length >= 3) {
        replacement = vault.getOrCreate("identifier", token)
        if (replacement !== token) renamed++
      }
      replaced += segment.text.slice(last, match.index) + replacement
      last = match.index + token.length
      if (token.length === 0) IDENTIFIER.lastIndex++
    }
    replaced += segment.text.slice(last)
    mock += replaced
  }

  // Truncate long files: keep head + tail so imports and entry points survive.
  const lines = mock.split("\n")
  let truncatedLines = 0
  if (lines.length > options.maxLines) {
    truncatedLines = lines.length - options.maxLines
    const headCount = Math.ceil(options.maxLines * 0.75)
    const tailCount = options.maxLines - headCount
    const elision = `\n/* … ${truncatedLines} lines elided by Mentat to save tokens … */\n`
    mock = [...lines.slice(0, headCount), elision, ...lines.slice(lines.length - tailCount)].join("\n")
  }

  return { realPath, mockPath, content: mock, renamed, redactedStrings, redactedComments, truncatedLines }
}

function scoreFile(path: string, content: string, keywords: string[]): number {
  let score = 0
  const hayPath = path.toLowerCase()
  const hayContent = content.toLowerCase()
  for (const keyword of keywords) {
    const term = keyword.toLowerCase().trim()
    if (term.length < 3) continue
    if (hayPath.includes(term)) score += 5
    let index = hayContent.indexOf(term)
    let hits = 0
    while (index >= 0 && hits < 10) {
      hits++
      score += 1
      index = hayContent.indexOf(term, index + term.length)
    }
  }
  // Prefer smaller, real source files over giant generated ones.
  score += Math.max(0, 10 - Math.floor(content.length / 4000))
  return score
}

/** Rank candidate files by relevance to the task keywords (deterministic). */
export function rankFiles(
  files: { path: string; content: string }[],
  keywords: string[],
): { path: string; content: string; score: number }[] {
  return files
    .map((file) => ({ ...file, score: scoreFile(file.path, file.content, keywords) }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
}
