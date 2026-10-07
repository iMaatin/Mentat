// IdentifierVault: the ONLY place real<->mock mappings live.
// The vault is never serialized into cloud-bound payloads. It stays in
// `.mentat/` on the local machine (gitignored, chmod 600 encouraged).

import { fnv1a } from "./rng.js"

export type VaultKind = "identifier" | "column" | "path" | "string" | "secret" | "entity"

export interface VaultEntry {
  kind: VaultKind
  real: string
  mock: string
}

export interface VaultJSON {
  version: 1
  seed: string
  entries: VaultEntry[]
}

// Plausible-looking word parts so mock code reads like real code.
const ADJECTIVES = [
  "bright", "calm", "rapid", "silent", "amber", "cobalt", "crisp",
  "harbor", "maple", "north", "oak", "pilot", "quartz", "river",
  "solar", "tandem", "union", "velvet", "willow", "yellow",
] as const

const NOUNS = [
  "ledger", "beacon", "cabin", "drift", "engine", "field", "grove",
  "harbor", "index", "junction", "kernel", "lantern", "meadow", "node",
  "orchard", "parcel", "quarry", "relay", "signal", "trail",
  "umbra", "vector", "wharf", "yew", "zinc", "anchor", "brook",
  "cinder", "dune", "ember",
] as const

function cleanWord(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z]/g, "")
}

function candidateMock(seed: string, real: string, attempt: number): string {
  const hash = fnv1a(`${seed}\u0000${real}\u0000${attempt}`)
  const adjective = cleanWord(ADJECTIVES[hash % ADJECTIVES.length] as string)
  const noun = cleanWord(NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length] as string)
  const suffix = attempt === 0 ? "" : String(attempt + 1)
  return `${adjective}_${noun}${suffix}`
}

function preserveCase(real: string, mock: string): string {
  if (real === real.toUpperCase() && /[A-Z]/.test(real)) return mock.toUpperCase()
  if (/^[A-Z][a-zA-Z0-9_]*$/.test(real)) return mock.charAt(0).toUpperCase() + mock.slice(1)
  if (/^[A-Z][A-Z0-9_]*$/.test(real)) {
    const upper = mock.toUpperCase()
    return real.includes("_") ? upper : upper.replace(/_/g, "")
  }
  return mock
}

export class IdentifierVault {
  private byReal = new Map<string, VaultEntry>()
  private byMock = new Map<string, VaultEntry>()
  private reserved: Set<string>

  constructor(
    readonly seed: string,
    reservedTokens: Iterable<string> = [],
  ) {
    this.reserved = new Set(reservedTokens)
  }

  get size(): number {
    return this.byReal.size
  }

  getOrCreate(kind: VaultKind, real: string): string {
    const existing = this.byReal.get(real)
    if (existing) return existing.mock
    for (let attempt = 0; attempt < 1000; attempt++) {
      const mock = preserveCase(real, candidateMock(this.seed, `${kind}:${real}`, attempt))
      if (this.byMock.has(mock)) continue
      if (this.reserved.has(mock)) continue
      // A mock must never equal any known real token either.
      if (this.byReal.has(mock)) continue
      const entry: VaultEntry = { kind, real, mock }
      this.byReal.set(real, entry)
      this.byMock.set(mock, entry)
      return mock
    }
    throw new Error(`Mentat vault exhausted for ${kind}:${real}`)
  }

  mockFor(real: string): string | undefined {
    return this.byReal.get(real)?.mock
  }

  realFor(mock: string): string | undefined {
    return this.byMock.get(mock)?.real
  }

  entries(): VaultEntry[] {
    return [...this.byReal.values()]
  }

  mocks(): Set<string> {
    return new Set(this.byMock.keys())
  }

  /** True if `word` equals any known real token (case-insensitive). Used to keep Mentat-generated filler words collision-free. */
  collidesWithReal(word: string): boolean {
    const lower = word.toLowerCase()
    for (const real of this.byReal.keys()) {
      if (real.toLowerCase() === lower) return true
    }
    for (const token of this.reserved) {
      if (token.toLowerCase() === lower) return true
    }
    return false
  }

  /** All real values that must never appear in cloud-bound text. */
  secrets(minLength = 1): string[] {
    return this.entries()
      .map((entry) => entry.real)
      .filter((real) => real.length >= minLength)
  }

  toJSON(): VaultJSON {
    return { version: 1, seed: this.seed, entries: this.entries() }
  }

  static fromJSON(json: VaultJSON, reservedTokens: Iterable<string> = []): IdentifierVault {
    const vault = new IdentifierVault(json.seed, reservedTokens)
    for (const entry of json.entries) {
      vault.byReal.set(entry.real, entry)
      vault.byMock.set(entry.mock, entry)
    }
    return vault
  }
}
