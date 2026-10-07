// LeakScanner: deterministic fail-closed gate over every cloud-bound payload.
// Runs on (sanitized task + mock code + mock data + file paths). Any hit blocks egress.

export interface ScanFinding {
  /** Which rule fired: `secret:<kind>` or `pattern:<name>`. */
  rule: string
  /** Position in the scanned text. */
  index: number
  /** Length of the matched span. */
  length: number
  /** Redacted excerpt around the hit (never contains the full secret). */
  excerpt: string
}

export interface ScanVerdict {
  clean: boolean
  findings: ScanFinding[]
}

export interface ScanOptions {
  /** Secrets shorter than this are skipped (avoids `id`, `if` style false positives). */
  minSecretLength?: number
  /** Case-insensitive matching for vault secrets. Default false. */
  caseInsensitiveSecrets?: boolean
  /** Extra regex patterns treated as leaks. */
  extraPatterns?: { name: string; pattern: RegExp }[]
  /** Skip built-in high-entropy token detection. Default false. */
  skipEntropy?: boolean
}

// Substring (not word-boundary) matching is right for secrets with special
// characters (keys, tokens, paths); word-ish secrets use boundaries to cut FPs.
const WORDISH = /^[A-Za-z0-9_]+$/

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Redact: keep 2 chars on each side of the match inside a small window so the
// audit log and error messages never carry the secret itself.
function redactedExcerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 24)
  const end = Math.min(text.length, index + length + 24)
  const before = text.slice(start, index)
  const after = text.slice(index + length, end)
  const head = text.slice(index, Math.min(index + 2, index + length))
  const tail = text.slice(Math.max(index, index + length - 2), index + length)
  return `${start > 0 ? "…" : ""}${before}⟦${head}***${tail}⟧${after}${end < text.length ? "…" : ""}`
}

const BUILTIN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws-secret-assign", pattern: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{20,}/gi },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "generic-api-assign", pattern: /\b(api[_-]?key|apikey|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/gi },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9_\-./+=]{20,}\b/g },
  { name: "connection-string", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|sqlserver):\/\/[^\s"']+/gi },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
]

function shannonEntropy(token: string): number {
  const counts = new Map<string, number>()
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / token.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

const ENTROPY_TOKEN = /[A-Za-z0-9_\-./+=]{24,}/g

export function scanForLeaks(text: string, secrets: readonly string[], options: ScanOptions = {}): ScanVerdict {
  const findings: ScanFinding[] = []
  const minSecretLength = options.minSecretLength ?? 4
  const flags = options.caseInsensitiveSecrets === true ? "gi" : "g"

  const seenSecrets = new Set<string>()
  for (const secret of secrets) {
    if (secret.length < minSecretLength) continue
    if (seenSecrets.has(secret)) continue
    seenSecrets.add(secret)
    const source = WORDISH.test(secret) ? `\\b${escapeRegExp(secret)}\\b` : escapeRegExp(secret)
    const pattern = new RegExp(source, flags)
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    let guard = 0
    while ((match = pattern.exec(text)) !== null && guard++ < 50) {
      findings.push({
        rule: "secret:vault",
        index: match.index,
        length: match[0].length,
        excerpt: redactedExcerpt(text, match.index, match[0].length),
      })
      if (match[0].length === 0) pattern.lastIndex++
    }
  }

  const patterns = [...BUILTIN_PATTERNS, ...(options.extraPatterns ?? [])]
  for (const { name, pattern } of patterns) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    let guard = 0
    while ((match = pattern.exec(text)) !== null && guard++ < 50) {
      findings.push({
        rule: `pattern:${name}`,
        index: match.index,
        length: match[0].length,
        excerpt: redactedExcerpt(text, match.index, match[0].length),
      })
      if (match[0].length === 0) pattern.lastIndex++
    }
  }

  if (options.skipEntropy !== true) {
    ENTROPY_TOKEN.lastIndex = 0
    let match: RegExpExecArray | null
    let guard = 0
    while ((match = ENTROPY_TOKEN.exec(text)) !== null && guard++ < 500) {
      const token = match[0]
      // Skip version-ish / hash-ish runs the user explicitly allowed by shape.
      if (/^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i.test(token)) continue
      if (shannonEntropy(token) >= 4.6 && token.length >= 24) {
        findings.push({
          rule: "pattern:high-entropy-token",
          index: match.index,
          length: token.length,
          excerpt: redactedExcerpt(text, match.index, token.length),
        })
      }
    }
  }

  // Mentat-generated documentation hosts are fixed strings that cannot carry
  // user data (`redactNetworkLiterals` reduces every URL host to one of these
  // or flags it). Exempt findings fully inside such a host span so a real
  // identifier like `example` can never false-positive here. Paths, query
  // strings, and non-conforming URLs are still fully scanned.
  const EXEMPT_HOST = /https?:\/\/(?:example\.com|example\.org|localhost|127\.0\.0\.1)(?::\d+)?/gi
  const exempt: { start: number; end: number }[] = []
  EXEMPT_HOST.lastIndex = 0
  let exemptMatch: RegExpExecArray | null
  while ((exemptMatch = EXEMPT_HOST.exec(text)) !== null) {
    exempt.push({ start: exemptMatch.index, end: exemptMatch.index + exemptMatch[0].length })
    if (exemptMatch[0].length === 0) EXEMPT_HOST.lastIndex++
  }
  const kept = findings.filter(
    (finding) =>
      !exempt.some((span) => finding.index >= span.start && finding.index + finding.length <= span.end),
  )

  kept.sort((a, b) => a.index - b.index)
  return { clean: kept.length === 0, findings: kept }
}

export function formatFindings(findings: readonly ScanFinding[], limit = 10): string {
  return findings
    .slice(0, limit)
    .map((finding) => `- [${finding.rule}] @${finding.index}: ${finding.excerpt}`)
    .join("\n")
}
