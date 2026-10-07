// Audit log: append-only JSONL records of every Mentat egress decision.
// Records carry hashes + redacted finding counts — never secrets, never vaults.

import { createHash } from "node:crypto"

export type AuditPhase = "prepare" | "send" | "reintegrate" | "blocked"

export interface AuditRecord {
  timestamp: string
  sessionID: string
  bundleID: string
  phase: AuditPhase
  verdict: "allow" | "deny"
  cloudAgent?: string
  egressSha256?: string
  findingRules?: string[]
  stats?: Record<string, number | string>
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function auditLine(record: AuditRecord): string {
  return `${JSON.stringify(record)}\n`
}

export class MentatLeakError extends Error {
  findings: { rule: string; excerpt: string }[]

  constructor(message: string, findings: { rule: string; excerpt: string }[]) {
    super(message)
    this.name = "MentatLeakError"
    this.findings = findings
  }
}
