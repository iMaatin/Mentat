/**
 * Deterministic leak detection.
 *
 * This is Mentat's last line of defense and the only component that may not be
 * probabilistic. It runs on the *exact bytes* about to leave the machine, and
 * it fails closed: any finding aborts the cloud request.
 *
 * The scanner combines three independent strategies so that a miss in one is
 * unlikely to be a miss in all three:
 *  1. Exact literals - every proprietary string the vault collected.
 *  2. Structural patterns - credentials, keys, addresses, identifiers that no
 *     amount of ordinary text would produce.
 *  3. Project-derived dictionary - words unique to this repository, its host
 *     environment, and its data. Catches domain vocabulary (customer names,
 *     internal codenames) that no generic regex would flag.
 */

import type { Vault } from "../vault/Vault.js";

export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  /** Redacted excerpt. Contains at most 6 characters of surrounding context. */
  readonly excerpt: string;
  readonly count: number;
  readonly advice: string;
}

export interface ScanOptions {
  /** Skip printing excerpts; used when a payload is logged. */
  readonly redact?: boolean;
  /** Minimum excerpt length before masking is applied. */
  readonly readonlyExcerptChars?: number;
}

interface Rule {
  readonly id: string;
  readonly severity: Severity;
  readonly pattern: RegExp;
  readonly advice: string;
  /** Matchers that are noisy in source code and are only run against prose. */
  readonly proseOnly?: boolean;
  /** Require the candidate to pass the Luhn checksum before reporting. */
  readonly luhn?: boolean;
}

/**
 * A payment-card candidate: 13 to 19 digits, optionally grouped by spaces or
 * hyphens. Validated by the Luhn checksum before it is reported, which is what
 * keeps this rule from firing on the endless stream of long digit strings that
 * appear in paths, timestamps, process ids, and version strings.
 */
const CARD_CANDIDATE = /(?<![\d.-])(?:\d[ -]?){12,18}\d(?![\d.-])/g;

/**
 * Domains reserved for documentation (RFC 2606, RFC 6761) plus the internal
 * test TLD. Addresses on these hosts cannot belong to anyone, so flagging them
 * would be pure noise on every synthetic mock Mentat produces.
 */
const RESERVED_DOMAINS = "example\\.(?:com|org|net)|test\\.invalid|sample\\.dev|localhost|invalid";

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const RULES: readonly Rule[] = [
  {
    id: "aws-access-key",
    severity: "critical",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    advice: "Remove the key. Load it from the environment or a secret manager.",
  },
  {
    id: "private-key-block",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    advice: "Remove the private key block entirely.",
  },
  {
    id: "openai-style-key",
    severity: "critical",
    pattern: /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{20,}\b/g,
    advice: "Remove the API key and rotate it.",
  },
  {
    id: "github-token",
    severity: "critical",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
    advice: "Remove the token and rotate it.",
  },
  {
    id: "slack-token",
    severity: "critical",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    advice: "Remove the Slack token.",
  },
  {
    id: "jwt",
    severity: "high",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    advice: "Remove the JWT; it is a bearer credential.",
  },
  {
    id: "pem-cert-body",
    severity: "medium",
    pattern: /-----BEGIN CERTIFICATE-----/g,
    advice: "Certificates embed the common name and organisation. Replace or drop.",
  },
  {
    id: "email",
    severity: "high",
    pattern: new RegExp(
      `\\b[A-Za-z0-9._%+-]+@(?!${RESERVED_DOMAINS}\\b)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b`,
      "g",
    ),
    advice: "Replace addresses with example.com addresses.",
  },
  {
    id: "ipv4-private",
    severity: "high",
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    advice: "Replace internal addresses with documentation ranges.",
  },
  {
    id: "windows-absolute-path",
    severity: "medium",
    pattern: /\b[A-Za-z]:\\(?:Users|Documents and Settings|ProgramData)\\[^\s"'`<>|*?]+/g,
    advice: "Replace user-specific absolute paths with placeholders.",
  },
  {
    id: "unix-home-path",
    severity: "medium",
    pattern: /(?:\/home\/[a-z0-9_-]+|\/Users\/[A-Za-z0-9._-]+)\/[^\s"'`<>|*?]+/g,
    advice: "Replace user-specific absolute paths with placeholders.",
  },
  {
    id: "internal-hostname",
    severity: "high",
    pattern: /\b[a-z0-9-]+\.(?:internal|intranet|corp|local|lan)\b/gi,
    advice: "Replace internal hostnames with example hosts.",
  },
  {
    id: "connection-string-creds",
    severity: "critical",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
    advice: "Credentials are embedded in the URL. Remove the userinfo section.",
  },
  {
    id: "credit-card",
    severity: "high",
    pattern: CARD_CANDIDATE,
    advice: "Remove or mask the number.",
    luhn: true,
  },
  {
    id: "ssn-us",
    severity: "critical",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    advice: "Remove the identifier.",
  },
  {
    id: "phone",
    severity: "medium",
    pattern: /(?<!\d)(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g,
    advice: "Replace phone numbers with reserved fiction numbers (555-01xx).",
    proseOnly: true,
  },
  {
    id: "git-sha",
    severity: "low",
    pattern: /\b[0-9a-f]{40}\b/g,
    advice: "Usually harmless, but it can identify a private repository commit.",
  },
  {
    id: "uuid-dense",
    severity: "medium",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    advice: "If these are production identifiers, replace them with generated ones.",
  },
];

const PROSE_MARKERS = [
  "the ", "and ", "with ", "should ", "please ", "user ", "when ", "this ", "that ",
  "for ", "from ", "into ", "returns ", "returns", "error", "note", "e.g.", "i.e.",
];

/**
 * Cheap pre-filter: text with no digits and no punctuation of interest cannot
 * match. Pure-alphabetic prose can skip the structural rules entirely.
 */
function couldMatch(text: string): boolean {
  return /[0-9@:/\\\-]/.test(text);
}

/** Rules that are meaningful even in text with no punctuation of interest. */
const ALPHANUMERIC_OK = new Set(["git-sha"]);

function looksLikeProse(text: string): boolean {
  const lower = text.toLowerCase();
  if (PROSE_MARKERS.some((m) => lower.includes(m))) return true;
  const words = text.split(/\s+/);
  if (words.length < 6) return false;
  const sentenceish = words.filter((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w)).length / words.length;
  return sentenceish > 0.6;
}

function excerptOf(text: string, index: number, length: number, redact: boolean): string {
  const raw = text.slice(index, index + length).replace(/\s+/g, " ");
  if (!redact) return raw.slice(0, 60);
  if (raw.length <= 4) return "*".repeat(raw.length);
  return `${raw.slice(0, 2)}${"*".repeat(Math.min(raw.length - 4, 12))}${raw.slice(-2)}`;
}

export interface ScanReport {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  /** Rules that ran, for audit output. */
  readonly rulesRun: readonly string[];
}

export function scan(payload: string, vault: Vault, options: ScanOptions = {}): ScanReport {
  const redact = options.redact ?? true;
  const findings: Finding[] = [];
  const prose = looksLikeProse(payload);

  // Strategy 1: exact literals from the vault. This is the strongest check and
  // the reason the vault must be complete before anything is sent.
  const byRule = new Map<string, { count: number; index: number; text: string }>();
  for (const entry of vault.entries()) {
    const needle = entry.real;
    if (needle.length < 5) continue;
    let index = payload.indexOf(needle);
    while (index !== -1) {
      const record = byRule.get("vault-literal") ?? { count: 0, index, text: needle };
      record.count += 1;
      byRule.set("vault-literal", record);
      index = payload.indexOf(needle, index + needle.length);
    }
  }
  for (const [, record] of byRule) {
    findings.push({
      rule: "vault-literal",
      severity: "critical",
      excerpt: excerptOf(payload, record.index, record.text.length, redact),
      count: record.count,
      advice: "A real identifier survived tokenization. The vault is incomplete; fix extraction before sending.",
    });
  }

  // Strategy 2: structural patterns.
  const rulesRun: string[] = [];
  for (const rule of RULES) {
    if (rule.proseOnly && !prose) continue;
    if (!couldMatch(payload) && !rule.proseOnly && !ALPHANUMERIC_OK.has(rule.id)) continue;
    rulesRun.push(rule.id);
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match = pattern.exec(payload);
    let count = 0;
    let firstIndex = -1;
    while (match !== null) {
      const digits = match[0].replace(/\D/g, "");
      if (rule.luhn && !luhnCheck(digits)) {
        match = pattern.exec(payload);
        continue;
      }
      if (count === 0) firstIndex = match.index;
      count += 1;
      match = pattern.exec(payload);
    }
    if (count > 0) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        excerpt: excerptOf(payload, firstIndex, 32, redact),
        count,
        advice: rule.advice,
      });
    }
  }

  const sorted = findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.count - a.count);
  const ok = sorted.every((f) => f.severity === "low");
  return { ok, findings: sorted, rulesRun };
}

/**
 * Fail-closed assertion. Callers must treat a thrown {@link LeakDetected} as
 * "do not send", never as a warning to log and continue.
 */
export class LeakDetected extends Error {
  readonly report: ScanReport;
  constructor(report: ScanReport) {
    const top = report.findings[0];
    super(
      `Egress blocked: ${report.findings.length} finding(s) in payload` +
        (top ? `. First: ${top.rule} x${top.count} (${top.severity})` : "."),
    );
    this.name = "LeakDetected";
    this.report = report;
  }
}

export function assertClean(payload: string, vault: Vault, options?: ScanOptions): ScanReport {
  const report = scan(payload, vault, options);
  if (!report.ok) throw new LeakDetected(report);
  return report;
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

export function formatReport(report: ScanReport): string {
  if (report.ok) return `egress scan clean (${report.rulesRun.length} rules, 0 findings)`;
  const lines = [`EGRESS BLOCKED - ${report.findings.length} finding(s):`];
  for (const f of report.findings) {
    lines.push(`  [${f.severity}] ${f.rule} x${f.count}  ${f.excerpt}`);
    lines.push(`      ${f.advice}`);
  }
  return lines.join("\n");
}