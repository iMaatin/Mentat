// Reintegrator: translate cloud output from MOCK space back to REAL space.
// Cloud output is UNTRUSTED (prompt-injection source): this module only maps
// identifiers/paths textually and reports what it could not map. The local
// agent applies changes via edit tools, reviews, and runs tests.

import type { IdentifierVault } from "./vault.js"

export interface ReintegrateReport {
  /** Cloud output with mock identifiers/paths mapped back to real ones. */
  realText: string
  mapped: number
  /** Mock tokens the cloud model produced that are NOT in the vault. */
  unmappedMocks: string[]
  /** Vault mocks that survived translation (should be none). */
  leftoverMocks: string[]
  warnings: string[]
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const DIFF_PATH = /^(?:diff --git a\/(\S+) b\/(\S+)|--- a\/(\S+)|\+\+\+ b\/(\S+))$/gm
const MOCKISH = /\b[a-z]+_[a-z]+[0-9]*\b/g

export function reintegrateCloudOutput(cloudOutput: string, vault: IdentifierVault): ReintegrateReport {
  const warnings: string[] = []
  // Longest-first so `bright_ledger2` maps before `bright_ledger`.
  const entries = [...vault.entries()].sort((a, b) => b.mock.length - a.mock.length)
  let realText = cloudOutput
  let mapped = 0
  for (const entry of entries) {
    const pattern = new RegExp(`\\b${escapeRegExp(entry.mock)}\\b`, "g")
    const next = realText.replace(pattern, entry.real)
    if (next !== realText) {
      mapped++
      realText = next
    }
  }

  // Diff headers carry `a/<path>` prefixes; the word-boundary pass above
  // already mapped the mock stems inside them. Collect unmapped mock-LOOKING
  // tokens the cloud invented (hallucinated new identifiers).
  const vaultMocks = vault.mocks()
  const unmapped = new Set<string>()
  MOCKISH.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MOCKISH.exec(cloudOutput)) !== null) {
    const token = match[0]
    if (!vaultMocks.has(token) && !vault.realFor(token)) unmapped.add(token)
    if (token.length === 0) MOCKISH.lastIndex++
  }

  const leftover = new Set<string>()
  for (const mock of vaultMocks) {
    if (new RegExp(`\\b${escapeRegExp(mock)}\\b`).test(realText)) leftover.add(mock)
  }
  // `leftover` should be empty by construction; if not, flag loudly.
  if (leftover.size > 0) {
    warnings.push(
      `Translation incomplete: ${leftover.size} mock token(s) survived (they may collide with real words). Review manually.`,
    )
  }

  // Sanity: diff paths should reference mock files the cloud was shown.
  DIFF_PATH.lastIndex = 0
  const referenced = new Set<string>()
  let diffMatch: RegExpExecArray | null
  while ((diffMatch = DIFF_PATH.exec(cloudOutput)) !== null) {
    for (const group of diffMatch.slice(1)) {
      if (group) referenced.add(group)
    }
  }

  const knownMockPaths = new Set(
    vault.entries().filter((entry) => entry.kind === "path").map((entry) => entry.mock),
  )
  for (const ref of referenced) {
    const stem = ref.split("/").pop()?.split(".")[0] ?? ""
    if (stem !== "" && !knownMockPaths.has(stem) && !knownMockPaths.has(ref)) {
      warnings.push(`Cloud diff references unknown mock path: ${ref}`)
    }
  }

  return {
    realText,
    mapped,
    unmappedMocks: [...unmapped].sort().slice(0, 50),
    leftoverMocks: [...leftover].sort(),
    warnings,
  }
}
