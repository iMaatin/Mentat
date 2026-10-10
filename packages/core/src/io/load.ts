/**
 * Dataset I/O.
 *
 * Formats fall into two groups:
 *  - CSV / JSON / JSONL are handled in-process. No dependency, no subprocess,
 *    and the fast path for the common case.
 *  - Parquet / Excel / SQLite require pandas or duckdb, so they go through a
 *    short-lived Python sidecar. The sidecar runs entirely locally and is the
 *    only component that touches raw bytes; it emits JSON on stdout.
 *
 * The sidecar contract is deliberately narrow: read -> JSON rows, and write JSON
 * rows -> format. All profiling and synthesis stays in TypeScript so the
 * statistical logic is testable without Python.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";

export type DatasetFormat = "csv" | "tsv" | "json" | "jsonl" | "parquet" | "xlsx" | "sqlite";

export interface Dataset {
  readonly name: string;
  readonly format: DatasetFormat;
  /**
   * Rows of the primary table. For sources that expose several tables this is
   * the single table when there is only one; multi-table sources carry
   * everything in `tables`.
   */
  readonly rows: readonly Record<string, unknown>[];
  /** Present for sources holding more than one table. */
  readonly tables?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /**
   * Every table as `{ name, rows }`, always populated. Callers that need to
   * mock a workbook or a database iterate this instead of guessing whether
   * `rows` happens to be populated.
   */
  readonly sheets: readonly { name: string; rows: readonly Record<string, unknown>[] }[];
}

const EXT_FORMAT: Readonly<Record<string, DatasetFormat>> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".json": "json",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".parquet": "parquet",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
  ".xlsb": "xlsx",
  ".db": "sqlite",
  ".sqlite": "sqlite",
  ".sqlite3": "sqlite",
};

export function formatFor(path: string): DatasetFormat {
  const ext = extname(path).toLowerCase();
  return EXT_FORMAT[ext] ?? "csv";
}

export function isNativeFormat(format: DatasetFormat): boolean {
  return format === "csv" || format === "tsv" || format === "json" || format === "jsonl";
}

export function supportsFormat(format: DatasetFormat): boolean {
  return isNativeFormat(format) || hasPython();
}

// ---------------------------------------------------------------------------
// Native readers
// ---------------------------------------------------------------------------

/**
 * RFC 4180 CSV parser. Written by hand rather than pulled from npm because this
 * code sits directly on the trust boundary: it must be auditable, and its
 * behaviour on malformed quoting must be predictable.
 */
export function parseDelimited(text: string, delimiter: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const endField = (): void => {
    record.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    // Skip entirely blank records, which trailing newlines otherwise produce.
    if (record.length > 1 || record[0] !== "") rows.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || record.length > 0) endRecord();

  const header = rows.shift();
  if (!header) return [];
  return rows.map((r) => {
    const obj: Record<string, unknown> = {};
    header.forEach((key, idx) => {
      const raw = r[idx];
      obj[key] = coerceScalar(raw === undefined ? "" : raw);
    });
    return obj;
  });
}

function coerceScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return null;
  if (t === "null" || t === "NULL" || t === "None") return null;
  if (t === "true" || t === "True") return true;
  if (t === "false" || t === "False") return false;
  if (/^-?\d+$/.test(t) && t.length < 16) return Number(t);
  if (/^-?\d*\.\d+(?:[eE][-+]?\d+)?$/.test(t)) return Number(t);
  return raw;
}

export function serializeDelimited(rows: readonly Record<string, unknown>[], delimiter: string): string {
  if (rows.length === 0) return "";
  const header = Object.keys(rows[0] ?? {});
  const lines = [header.map((h) => escapeField(h, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(header.map((h) => escapeField(stringifyCell(row[h]), delimiter)).join(delimiter));
  }
  return lines.join("\n") + "\n";
}

function escapeField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes("\n")) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export async function readDataset(path: string, format?: DatasetFormat): Promise<Dataset> {
  const fmt = format ?? formatFor(path);
  const name = tableNameFor(path, fmt);
  if (isNativeFormat(fmt)) {
    const rows = await readNative(path, fmt);
    return { name, format: fmt, rows, sheets: [{ name, rows }] };
  }
  const raw = await readViaPython(path, fmt, name);
  return shapeDataset(name, fmt, raw.rows ?? [], raw.tables);
}

/**
 * Normalizes a sidecar result into the Dataset contract.
 *
 * A single-table source is also exposed through `rows`, because that is what
 * nearly every caller wants and forcing them to special-case workbooks would be
 * a trap. Multi-table sources stay in `sheets` and must be iterated.
 */
function shapeDataset(
  name: string,
  format: DatasetFormat,
  rows: readonly Record<string, unknown>[],
  tables?: Readonly<Record<string, readonly Record<string, unknown>[]>>,
): Dataset {
  if (!tables || Object.keys(tables).length === 0) {
    return { name, format, rows, sheets: [{ name, rows }] };
  }
  const sheets = Object.entries(tables).map(([tableName, tableRows]) => ({
    name: tableName,
    rows: tableRows,
  }));
  const single = sheets.length === 1 ? sheets[0] : undefined;
  return {
    name: single ? single.name : name,
    format,
    rows: single ? single.rows : [],
    tables,
    sheets,
  };
}

function tableNameFor(path: string, format: DatasetFormat): string {
  const base = basename(path);
  if (format === "sqlite") return base.replace(/\.[^.]+$/, "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Streams large delimited files line by line instead of buffering the whole thing. */
async function readNative(path: string, format: DatasetFormat): Promise<Record<string, unknown>[]> {
  if (format === "json" || format === "jsonl") return readJsonish(path);
  const delimiter = format === "tsv" ? "\t" : ",";
  return new Promise<Record<string, unknown>[]>((resolvePromise, rejectPromise) => {
    const lines: string[] = [];
    const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    rl.on("line", (line: string) => lines.push(line));
    rl.on("close", () => resolvePromise(parseDelimited(lines.join("\n"), delimiter)));
    rl.on("error", (err: Error) => rejectPromise(err));
  });
}

async function readJsonish(path: string): Promise<Record<string, unknown>[]> {
  const text = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
  if (path.toLowerCase().endsWith(".jsonl") || path.toLowerCase().endsWith(".ndjson")) {
    return text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    // Common wrapper shapes.
    const obj = parsed as Record<string, unknown>;
    for (const key of ["data", "rows", "records", "items"]) {
      const candidate = obj[key];
      if (Array.isArray(candidate)) return candidate as Record<string, unknown>[];
    }
    return [obj];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Python sidecar
// ---------------------------------------------------------------------------

let pythonResolved: string | null | undefined;

export function hasPython(): boolean {
  return pythonResolved !== null;
}

export function pythonExecutable(): string | null {
  if (pythonResolved !== undefined) return pythonResolved;
  const candidates = [process.env.MENTAT_PYTHON, "python", "python3", "py"].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const candidate of candidates) {
    if (probePython(candidate)) {
      pythonResolved = candidate;
      return candidate;
    }
  }
  pythonResolved = null;
  return null;
}

/** Verifies the interpreter exists *and* already has pandas installed. */
function probePython(exe: string): boolean {
  try {
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(exe)) {
      // A `.cmd` shim cannot be probed directly on Node >= 20.12: the
      // CVE-2024-27980 mitigation makes that EINVAL. Drive it through
      // cmd.exe instead of silently reporting "no python with pandas".
      const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
      // The `/c` payload is wrapped in an outer quote pair: with `/s`, cmd
      // strips the first and last quote it sees, and without the outer pair it
      // would strip the quotes around the executable path instead.
      const cmdline = `"${exe}" -c "import pandas"`;
      const r = spawnSync(comspec, ["/d", "/s", "/c", `"${cmdline}"`], {
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      return !r.error && r.status === 0;
    }
    const r = spawnSync(exe, ["-c", "import pandas"], { stdio: "ignore", timeout: 15_000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

export class PythonUnavailable extends Error {
  constructor(format: DatasetFormat) {
    super(
      `Cannot read ${format} files: no Python interpreter with pandas was found.\n` +
        `Install pandas, or set MENTAT_PYTHON to an interpreter that has it:\n` +
        `  pip install pandas pyarrow openpyxl\n` +
        `Mentat will still handle CSV, TSV, JSON, and JSONL natively.`,
    );
    this.name = "PythonUnavailable";
  }
}

/**
 * Locates the bundled sidecar script.
 *
 * The compiled module lives at `<pkg>/dist/src/io/load.js`, so the package root
 * is four levels up. The candidates are tried in order so the script is still
 * found when the package is bundled, linked, or laid out differently.
 */
export function sidecarPath(): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(here, "..", "..", "..", "..", "python", "mentat_io.py"),
    resolve(here, "..", "..", "..", "python", "mentat_io.py"),
    resolve(here, "..", "..", "..", "..", "..", "python", "mentat_io.py"),
    resolve(process.cwd(), "packages", "core", "python", "mentat_io.py"),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0] as string;
}

interface PythonRequest {
  readonly op: "read" | "write";
  readonly path: string;
  readonly format: string;
  readonly rows?: readonly Record<string, unknown>[];
  readonly name?: string;
  readonly tables?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly limit?: number;
}

export function pythonAvailable(): boolean {
  return pythonExecutable() !== null;
}

/**
 * Hard ceiling on a sidecar invocation.
 *
 * Without it, a hung interpreter (a file lock, a prompt, a wedged driver)
 * hangs the whole pipeline: every later stage waits on a process that will
 * never emit its JSON. The limit is generous because a large workbook read
 * through openpyxl is genuinely slow; anything approaching it is a hang.
 */
const SIDECAR_TIMEOUT_DEFAULT_MS = 300_000;

function sidecarTimeoutMs(): number {
  const fromEnv = Number(process.env.MENTAT_SIDECAR_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : SIDECAR_TIMEOUT_DEFAULT_MS;
}

async function runPython(req: PythonRequest): Promise<string> {
  const exe = pythonExecutable();
  if (!exe) throw new PythonUnavailable(req.format as DatasetFormat);
  const script = sidecarPath();
  if (!existsSync(script)) {
    throw new Error(`Mentat Python sidecar not found at ${script}. Reinstall the package.`);
  }
  const timeoutMs = sidecarTimeoutMs();
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    // Same EINVAL rule as every other `.cmd` on this codebase: a batch shim is
    // driven through cmd.exe with a quoted command line, never spawned directly.
    const isBatch = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(exe);
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    // Outer quote pair required: `cmd /s` strips the first and last quote of
    // the /c payload, so the executable's own quotes only survive inside it.
    const inner = `"${exe}" "${script}"`;
    const child = isBatch
      ? spawn(comspec, ["/d", "/s", "/c", `"${inner}"`], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(exe, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(
        new Error(
          `Python sidecar timed out after ${timeoutMs}ms reading ${req.path}.\n` +
            `Set MENTAT_SIDECAR_TIMEOUT_MS to raise the limit for very large files.`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    // The sidecar may exit before reading its request. The resulting EPIPE on
    // stdin surfaces as a stream "error" event, and an unhandled stream error
    // crashes the process; the close handler below already reports the failure.
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(
        err instanceof Error && err.message.includes("ENOENT")
          ? new PythonUnavailable(req.format as DatasetFormat)
          : new Error(`Python sidecar could not start: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(`Python sidecar failed (exit ${code}):\n${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolvePromise(stdout);
    });
    child.stdin.end(JSON.stringify(req));
  });
}

async function readViaPython(
  path: string,
  format: DatasetFormat,
  name: string,
): Promise<{ rows?: Record<string, unknown>[]; tables?: Record<string, Record<string, unknown>[]> }> {
  const stdout = await runPython({ op: "read", path, format });
  const parsed = JSON.parse(stdout) as {
    rows?: Record<string, unknown>[];
    tables?: Record<string, Record<string, unknown>[]>;
  };
  return { rows: parsed.rows ?? [], tables: parsed.tables };
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export async function writeDataset(
  path: string,
  dataset: Dataset,
  rows: readonly Record<string, unknown>[],
): Promise<string> {
  const format = dataset.format;
  const fs = await import("node:fs/promises");
  await fs.mkdir(resolve(path, ".."), { recursive: true });

  if (isNativeFormat(format)) {
    if (format === "json") {
      await fs.writeFile(path, JSON.stringify(rows, null, 2), "utf8");
      return path;
    }
    if (format === "jsonl") {
      await fs.writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
      return path;
    }
    await fs.writeFile(path, serializeDelimited(rows, format === "tsv" ? "\t" : ","), "utf8");
    return path;
  }

  await runPython({ op: "write", path, format, rows, name: dataset.name, tables: dataset.tables });
  return path;
}

/** Ensures a destination stream file exists and is writable. */
export async function ensureWritable(path: string): Promise<string> {
  const handle = await import("node:fs/promises").then((fs) => fs.open(path, "w"));
  await handle.close();
  return path;
}

export { createWriteStream };