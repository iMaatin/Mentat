// Tabular profiler + synthesizer.
// Profile (deterministic, local): dtypes, null/missingness rates, cardinality,
// ranges. Synthesize: a SMALL look-alike frame with the same columns (or
// deterministic aliases), same dtypes, and the same JOINT missingness pattern
// (mock rows reuse real null-mask rows, filled with fake values).

import { parseCsv, isMissingCell } from "./csv.js"
import { fnv1a, mulberry32, pick } from "./rng.js"
import type { ColumnPolicy } from "./config.js"
import type { IdentifierVault } from "./vault.js"

export type DType = "integer" | "float" | "boolean" | "datetime" | "string"

export type StringKind = "email" | "phone" | "uuid" | "url" | "id" | "text"

export interface ColumnProfile {
  name: string
  mockName: string
  dtype: DType
  nullCount: number
  nullRate: number
  distinct: number
  min?: string
  max?: string
  decimals?: number
  stringKind?: StringKind
  /** Egress-safe display label for the string kind (vault-collision checked). */
  kindLabel?: string
}

// Display words deliberately uncommon as identifiers; still collision-checked.
const KIND_LABELS: Record<StringKind, string> = {
  email: "mailbox",
  phone: "telephone",
  uuid: "uuid128",
  url: "hyperlink",
  id: "idcode",
  text: "freetext",
}

export function safeKindLabel(kind: StringKind, vault: IdentifierVault): string {
  const primary = KIND_LABELS[kind]
  if (!vault.collidesWithReal(primary)) return primary
  let i = 0
  while (vault.collidesWithReal(`${primary}${i}`)) i++
  return `${primary}${i}`
}

export interface TableProfile {
  name: string
  mockName: string
  rowCount: number
  columns: ColumnProfile[]
  /** Null mask per sampled real row: masks[r][c] === true means missing. */
  nullMasks: boolean[][]
  delimiter: string
}

const INTEGER = /^[+-]?\d+$/
const FLOAT = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/
const BOOLEAN = /^(?:true|false|yes|no|y|n|t|f)$/i

function decimalsOf(value: string): number {
  const dot = value.indexOf(".")
  if (dot < 0) return 0
  return value.length - dot - 1
}

function inferDType(cells: string[]): DType {
  let sawInt = false
  let sawFloat = false
  let sawBool = false
  let sawDate = false
  let sawString = false
  for (const cell of cells) {
    if (isMissingCell(cell)) continue
    const trimmed = cell.trim()
    if (INTEGER.test(trimmed)) {
      sawInt = true
      continue
    }
    if (FLOAT.test(trimmed)) {
      sawFloat = true
      continue
    }
    if (BOOLEAN.test(trimmed)) {
      sawBool = true
      continue
    }
    const time = Date.parse(trimmed)
    if (!Number.isNaN(time) && /[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}\/[0-9]{2}\/[0-9]{4}/.test(trimmed)) {
      sawDate = true
      continue
    }
    sawString = true
  }
  if (sawString) return "string"
  if (sawDate) return "datetime"
  if (sawBool && !sawInt && !sawFloat) return "boolean"
  if (sawFloat) return "float"
  if (sawInt) return "integer"
  return "string"
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE = /^[+()\-.\s]*\d[+()\-.\s\d]{6,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URL = /^https?:\/\/\S+$/i
const IDISH = /^[A-Za-z]{1,6}[-_]?[0-9]{2,}$|^[0-9]+[-_][A-Za-z0-9]+$/

function detectStringKind(cells: string[]): NonNullable<ColumnProfile["stringKind"]> {
  let email = 0
  let phone = 0
  let uuid = 0
  let url = 0
  let idish = 0
  let total = 0
  for (const cell of cells) {
    if (isMissingCell(cell)) continue
    total++
    const trimmed = cell.trim()
    if (EMAIL.test(trimmed)) email++
    else if (UUID.test(trimmed)) uuid++
    else if (URL.test(trimmed)) url++
    else if (PHONE.test(trimmed)) phone++
    else if (IDISH.test(trimmed)) idish++
    if (total >= 200) break
  }
  if (total === 0) return "text"
  if (email / total > 0.6) return "email"
  if (uuid / total > 0.6) return "uuid"
  if (url / total > 0.6) return "url"
  if (phone / total > 0.6) return "phone"
  if (idish / total > 0.6) return "id"
  return "text"
}

export function mockColumnName(vault: IdentifierVault, policy: ColumnPolicy, name: string): string {
  if (policy === "keep") return name
  if (policy === "hash") return `col_${fnv1a(`col:${name}`).toString(16).padStart(8, "0")}`
  return vault.getOrCreate("column", name)
}

export interface ProfileOptions {
  name: string
  columnPolicy: ColumnPolicy
  /** Cap rows inspected (profiling budget for large files). */
  maxProfileRows?: number
}

export function profileCsv(csvText: string, vault: IdentifierVault, options: ProfileOptions): TableProfile {
  const parsed = parseCsv(csvText)
  const maxRows = options.maxProfileRows ?? 20000
  const rows = parsed.rows.slice(0, maxRows)
  const mockName = vault.getOrCreate("path", options.name)
  const columns: ColumnProfile[] = parsed.header.map((name) => {
    const index = parsed.header.indexOf(name)
    const cells = rows.map((row) => row[index] ?? "")
    const dtype = inferDType(cells)
    let nullCount = 0
    const distinctSet = new Set<string>()
    let min: string | undefined
    let max: string | undefined
    let decimals = 0
    for (const cell of cells) {
      if (isMissingCell(cell)) {
        nullCount++
        continue
      }
      distinctSet.add(cell)
      const trimmed = cell.trim()
      if (dtype === "integer" || dtype === "float") {
        const num = Number(trimmed)
        if (min === undefined || num < Number(min)) min = trimmed
        if (max === undefined || num > Number(max)) max = trimmed
        decimals = Math.max(decimals, decimalsOf(trimmed))
      } else if (dtype === "datetime") {
        if (min === undefined || trimmed < min) min = trimmed
        if (max === undefined || trimmed > max) max = trimmed
      }
      // NOTE: string cell values are never stored in the profile — real data
      // values must not linger anywhere near the egress path.
    }
    const numericRange =
      (dtype === "integer" || dtype === "float" || dtype === "datetime") &&
      min !== undefined &&
      max !== undefined
        ? { min, max }
        : {}
    const numericDecimals = dtype === "float" || dtype === "integer" ? { decimals } : {}
    const stringKind = dtype === "string" ? detectStringKind(cells) : undefined
    const stringExtras =
      stringKind !== undefined ? { stringKind, kindLabel: safeKindLabel(stringKind, vault) } : {}
    return {
      name,
      mockName: mockColumnName(vault, options.columnPolicy, name),
      dtype,
      nullCount,
      nullRate: rows.length === 0 ? 0 : nullCount / rows.length,
      distinct: distinctSet.size,
      ...numericRange,
      ...numericDecimals,
      ...stringExtras,
    }
  })
  const nullMasks = rows.map((row) =>
    parsed.header.map((_, index) => isMissingCell(row[index] ?? "")),
  )
  return { name: options.name, mockName, rowCount: parsed.rows.length, columns, nullMasks, delimiter: parsed.delimiter }
}

const FAKE_WORDS = [
  "harbor", "meadow", "signal", "quartz", "relay", "brook", "cinder", "dune",
  "ember", "field", "grove", "junction", "lantern", "orchard", "parcel", "trail",
] as const

/** Filler words for fake values, filtered against every known real token. */
export function safeFakeWords(vault: IdentifierVault): string[] {
  const safe = FAKE_WORDS.filter((word) => !vault.collidesWithReal(word))
  if (safe.length > 0) return [...safe]
  let i = 0
  while (vault.collidesWithReal(`filler${i}`)) i++
  return [`filler${i}`, `filler${i + 1}`]
}

function fakeUuid(rng: () => number): string {
  const hex = (count: number): string =>
    Array.from({ length: count }, () => Math.floor(rng() * 16).toString(16)).join("")
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(rng() * 4)).toString(16)}${hex(3)}-${hex(12)}`
}

function fakeValue(
  rng: () => number,
  column: ColumnProfile,
  rowIndex: number,
  words: readonly string[],
): string {
  switch (column.dtype) {
    case "boolean":
      return rng() < 0.5 ? "true" : "false"
    case "integer": {
      const lo = column.min !== undefined ? Number(column.min) : 0
      const hi = column.max !== undefined ? Number(column.max) : 100
      return String(lo + Math.floor(rng() * (hi - lo + 1)))
    }
    case "float": {
      const lo = column.min !== undefined ? Number(column.min) : 0
      const hi = column.max !== undefined ? Number(column.max) : 100
      return (lo + rng() * (hi - lo)).toFixed(column.decimals ?? 2)
    }
    case "datetime": {
      const lo = column.min !== undefined ? Date.parse(column.min) : Date.parse("2020-01-01")
      const hi = column.max !== undefined ? Date.parse(column.max) : Date.parse("2025-01-01")
      const safeLo = Number.isNaN(lo) ? Date.parse("2020-01-01") : lo
      const safeHi = Number.isNaN(hi) ? Date.parse("2025-01-01") : hi
      return new Date(safeLo + rng() * Math.max(0, safeHi - safeLo)).toISOString().slice(0, 19)
    }
    case "string": {
      const word = pick(rng, words)
      switch (column.stringKind) {
        case "email":
          return `${word}${rowIndex}@example.com`
        case "phone":
          return `+1-555-${String(1000 + Math.floor(rng() * 9000))}`
        case "uuid":
          return fakeUuid(rng)
        case "url":
          return `https://example.com/${word}/${rowIndex}`
        case "id":
          return `${word}-${String(10000 + rowIndex)}`
        default:
          return `${word} ${pick(rng, words)}`
      }
    }
  }
}

export interface SynthesizeOptions {
  rows: number
  seed: string
  vault: IdentifierVault
}

/**
 * Build a small look-alike frame. Each mock row copies one real null-mask row
 * (preserving the JOINT missingness pattern, e.g. "col B is null whenever col
 * A is null") and fills present cells with fake values in observed ranges.
 */
export function synthesizeMockRows(
  profile: TableProfile,
  options: SynthesizeOptions,
): { header: string[]; rows: string[][] } {
  const header = profile.columns.map((column) => column.mockName)
  const words = safeFakeWords(options.vault)
  const rng = mulberry32(fnv1a(`mock-rows\u0000${options.seed}\u0000${profile.name}`))
  const rows: string[][] = []
  const maskCount = profile.nullMasks.length
  for (let r = 0; r < options.rows; r++) {
    const mask = maskCount > 0 ? (profile.nullMasks[Math.floor(rng() * maskCount)] as boolean[]) : []
    const row = profile.columns.map((column, c) => {
      if (mask[c] === true) return ""
      return fakeValue(rng, column, r, words)
    })
    rows.push(row)
  }
  return { header, rows }
}

export function profileSummaryMarkdown(profile: TableProfile, includeRealCounts: boolean): string {
  const lines = [
    `dataset \`${profile.mockName}\`${includeRealCounts ? ` (real rows: ${profile.rowCount}, real name withheld)` : ""}`,
    "",
    "| column | dtype | null % | distinct | range |",
    "| --- | --- | --- | --- | --- |",
  ]
  for (const column of profile.columns) {
    const range =
      column.dtype === "integer" || column.dtype === "float" || column.dtype === "datetime"
        ? `${column.min ?? "?"} … ${column.max ?? "?"}`
        : (column.kindLabel ?? "freetext")
    lines.push(
      `| \`${column.mockName}\` | ${column.dtype} | ${(column.nullRate * 100).toFixed(1)}% | ${column.distinct} | ${range} |`,
    )
  }
  return lines.join("\n")
}
