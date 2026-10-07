// Minimal RFC-4180-ish CSV parser/stringifier. No dependencies on purpose:
// the mock-data path must stay small, deterministic, and dependency-free.

export interface ParsedCsv {
  header: string[]
  rows: string[][]
  delimiter: string
}

function sniffDelimiter(firstLine: string): string {
  const candidates = [",", ";", "\t", "|"]
  let best = ","
  let bestCount = -1
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1
    if (count > bestCount) {
      bestCount = count
      best = candidate
    }
  }
  return best
}

export function parseCsv(text: string): ParsedCsv {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const firstLine = normalized.split("\n", 1)[0] ?? ""
  const delimiter = sniffDelimiter(firstLine)
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0
  const pushField = () => {
    row.push(field)
    field = ""
  }
  const pushRow = () => {
    // Skip blank lines and the phantom row from a final newline.
    if (row.length === 0 && field === "") return
    pushField()
    rows.push(row)
    row = []
  }
  while (i < normalized.length) {
    const char = normalized[i] as string
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += char
      i++
      continue
    }
    if (char === '"') {
      inQuotes = true
      i++
      continue
    }
    if (char === delimiter) {
      pushField()
      i++
      continue
    }
    if (char === "\n") {
      pushRow()
      i++
      continue
    }
    field += char
    i++
  }
  if (field !== "" || row.length > 0) pushRow()
  const header = rows[0] ?? []
  return { header, rows: rows.slice(1), delimiter }
}

function escapeField(field: string, delimiter: string): string {
  if (field.includes('"') || field.includes(delimiter) || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
}

export function stringifyCsv(header: string[], rows: string[][], delimiter = ","): string {
  const lines = [header.map((cell) => escapeField(cell, delimiter)).join(delimiter)]
  for (const row of rows) lines.push(row.map((cell) => escapeField(cell, delimiter)).join(delimiter))
  return lines.join("\n") + "\n"
}

const MISSING_TOKENS = new Set(["", "na", "n/a", "nan", "null", "none", "nil", "nat", "?"])

export function isMissingCell(cell: string): boolean {
  return MISSING_TOKENS.has(cell.trim().toLowerCase())
}
