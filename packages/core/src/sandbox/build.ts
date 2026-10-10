/**
 * Sandbox construction.
 *
 * The sandbox is a complete, self-contained mirror of the repository in which
 * every proprietary element has been replaced: identifiers become tokens, tables
 * become synthetic, comments and prose are rewritten by the local model, and
 * absolute paths become relative.
 *
 * The sandbox must live OUTSIDE the original repository. If it sat inside the
 * project, the cloud agent's tools could walk up into the real tree, and the
 * privacy guarantee would be a promise rather than an enforcement. Mentat also
 * refuses to build a sandbox inside the repo it is mirroring, and records the
 * real root in a deny list that the egress check consults.
 */

import { mkdir, writeFile, rm, readdir, stat, readFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { basename, extname } from "node:path";
import { Vault, isStopword } from "../vault/Vault.js";
import { languageFor, sanitizeSource, scrubProse } from "../redact/source.js";
import type { Language } from "../redact/source.js";

export interface SandboxFile {
  /** Path inside the sandbox, always POSIX separators. */
  readonly path: string;
  readonly bytes: number;
  readonly kind: "code" | "data" | "doc" | "config" | "other";
  readonly language?: Language;
}

export interface SandboxManifest {
  readonly createdAt: string;
  readonly realRoot: string;
  readonly sandboxRoot: string;
  readonly files: readonly SandboxFile[];
  readonly mockData: readonly MockDatasetRecord[];
  readonly tokenCount: number;
  readonly omissions: readonly OmissionRecord[];
}

/** `readdir` with `withFileTypes` returns buffer-typed names under some Node
 *  typings; pin them to string so path handling stays honest. */
async function readDirEntries(dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> {
  const entries = (await readdir(dir, { withFileTypes: true })) as unknown as Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>;
  return entries;
}

interface MockDatasetRecord {
  readonly realPath: string;
  readonly sandboxPath: string;
  readonly rows: number;
  readonly sourceRows: number;
  readonly profile: string;
}

export interface OmissionRecord {
  readonly path: string;
  readonly reason: string;
}

/**
 * One mocked dataset destined for the sandbox.
 *
 * A source path may map to several of these: a workbook or a database holds
 * many tables, and each becomes its own synthetic file in the sandbox.
 */
export interface DatasetMockEntry {
  readonly realPath: string;
  readonly sandboxPath: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly profile: string;
  readonly sourceRows: number;
}

export interface BuildOptions {
  readonly realRoot: string;
  readonly sandboxRoot: string;
  /** Extra globs to exclude, beyond the built-in ignore set. */
  readonly exclude?: readonly string[];
  /** Include list of extensions; defaults to all known code and data types. */
  readonly includeExtensions?: readonly string[];
  /** Mocked datasets. Several entries may share one `realPath`. */
  readonly datasets?: readonly DatasetMockEntry[];
  /** Directory names never mirrored. */
  readonly readonlyNeverMirror?: readonly string[];
  /** Files larger than this are recorded as omissions, not mirrored. */
  readonly maxFileBytes?: number;
  /** Pre-populated free-text rewrites keyed by sandbox path. */
  readonly proseRewrites?: Readonly<Record<string, string>>;
  /**
   * Where to write the full manifest, which contains real paths. When set, the
   * sandbox receives a redacted summary instead.
   */
  readonly manifestPath?: string;
  readonly logger?: (message: string) => void;
}

const DEFAULT_EXCLUDE = [
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
  ".next", ".nuxt", ".cache", ".venv", "venv", "env", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".idea", ".vscode", "coverage",
  ".mentat", ".terraform", "vendor", "Pods", ".gradle", "obj", "bin",
];

/**
 * Files that are never mirrored, whatever their extension.
 *
 * These hold live credentials in value form. The identifier tokenizer only
 * replaces *names* it recognizes, so a `KEY=value` line such as
 * `AWS_SECRET_ACCESS_KEY=...` would survive into the sandbox verbatim and be
 * readable by the cloud model. Vault tokenization cannot help here: the value
 * is not an identifier, and the file's own path becoming a token defeats the
 * scanner's keyword fast-paths. The only safe treatment is omission, recorded
 * in the manifest so the gap is visible rather than silent.
 */
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  // .env, .env.local, .env.production — and any `*.env` variant.
  /^\.env($|\..*)/i,
  /\.env$/i,
  // Key material, keystore exports, and PGP/GPG blocks.
  /\.(?:pem|key|p12|pfx|jks|keystore|asc|gpg)$/i,
  // SSH private keys, with or without a comment suffix (id_rsa.pub is public
  // and harmless, but it is rare enough in repos that omitting both is fine).
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  // Package-manager and tool auth files.
  /^(?:\.npmrc|\.netrc|\.htpasswd|\.pgpass)$/i,
  // Cloud/credential stores. `credentials.py` is a legitimate source file and
  // is deliberately NOT matched; only the extensionless and data forms are.
  /^credentials?(?:\.(?:json|ya?ml|ini|conf|txt))?$/i,
  /^\.dockerconfig\.json$/i,
];

/** Directories that exist solely to hold credentials. */
const SECRET_DIRECTORIES = new Set([".aws", ".ssh", ".gnupg", ".pki"]);

/** True when a file name marks the file as credential material. Exported for tests. */
export function isSecretFile(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((p) => p.test(name));
}

/** True when a directory name marks it as a credential store. Exported for tests. */
export function isSecretDirectory(name: string): boolean {
  return SECRET_DIRECTORIES.has(name.toLowerCase());
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sql", ".go", ".rs",
  ".java", ".cs", ".sh", ".bash", ".rb", ".php", ".kt", ".swift", ".c", ".h",
  ".cpp", ".hpp", ".scala", ".ex", ".exs", ".lua", ".pl", ".r", ".jl",
]);

const CONFIG_EXTENSIONS = new Set([
  ".json", ".jsonc", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
  ".properties", ".xml", ".gradle", ".dockerfile", ".tf", ".tfvars",
]);

const DATA_EXTENSIONS = new Set([
  ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet", ".xlsx", ".xls",
  ".db", ".sqlite", ".sqlite3", ".avro", ".arrow", ".feather", ".h5", ".hdf5",
]);

const DOC_EXTENSIONS = new Set([".md", ".markdown", ".rst", ".txt", ".adoc", ".org"]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".a", ".lib", ".o", ".obj", ".class",
  ".jar", ".war", ".pyc", ".pyo", ".wasm", ".node", ".bin", ".dat", ".pack",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".woff", ".woff2", ".ttf", ".eot",
  ".onnx", ".pt", ".pth", ".safetensors", ".ckpt", ".pkl", ".npy", ".npz",
  ".h5", ".db-journal", ".sqlite-journal",
]);

const MAX_FILE_BYTES_DEFAULT = 512 * 1024;

/**
 * Writes a synthetic `AGENTS.md` into the sandbox. This is the instruction file
 * the cloud model reads first, and it is where Mentat states the ground rules of
 * the engagement: work only in this tree, treat the token vocabulary as real
 * identifiers, and never attempt to guess what the tokens mean.
 */
function agentsInstructions(sandboxName: string, vocab: readonly { token: string; kind: string }[]): string {
  const sample = vocab
    .filter((v) => v.kind === "tbl" || v.kind === "fn" || v.kind === "mod")
    .slice(0, 60)
    .map((v) => v.token)
    .join(", ");

  return `# ${sandboxName}

This repository is a self-contained synthetic mirror of a real system. Treat it
as a normal codebase: build, test, and refactor it the way you would any project.

## Ground rules

- Every identifier matching \`zq_*\` is a real identifier in this codebase. Use
  them exactly as written. Do not rename them, "prettify" them, or expand the
  prefix.
- Data files contain synthetic rows generated to match the real dataset's schema,
  missingness pattern, and distributions. Row counts are deliberately small.
- Never speculate about what a \`zq_*\` name stands for, and never invent
  business meaning for it. If a name is unclear, infer its role from how it is
  used at the call site and say so explicitly if the intent is ambiguous.
- All work happens inside this directory. Do not read paths outside it.

## Vocabulary

${sample || "(no identifiers recorded)"}
`;
}

/**
 * Filenames that must keep their exact name in the sandbox.
 *
 * These are tooling contracts, not project identifiers. Renaming `package.json`
 * or `requirements.txt` would stop the cloud model's build and test commands
 * from working, which costs more than the marginal privacy gain: none of these
 * names identifies an organization.
 */
const INFRASTRUCTURE_FILENAMES = new Set([
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "tsconfig.json", "jsconfig.json", "requirements.txt", "pyproject.toml", "setup.py",
  "setup.cfg", "pipfile", "poetry.lock", "makefile", "dockerfile", "docker-compose.yml",
  "docker-compose.yaml", "go.mod", "go.sum", "cargo.toml", "cargo.lock", "pom.xml",
  "build.gradle", "gradlew", "gemfile", "composer.json", "build.sbt", "justfile",
  "tox.ini", "pytest.ini", "mypy.ini", "ruff.toml", ".gitignore", ".dockerignore",
  ".editorconfig", ".prettierrc", ".eslintrc", "readme", "license", "changelog",
  "contributing", "codeowners", "notice", "authors",
]);

/**
 * Sandbox path for a mirrored file.
 *
 * The sandbox mirrors the repository layout but gives proprietary filenames a
 * token name, because a filename such as `acme_billing.py` identifies the
 * organization as plainly as an identifier does. Layer 3 restores the token in
 * the path, so a patch produced against `src/zq_mod_org_001.py` still lands on
 * the correct real file: the same mechanism that restores identifiers in code
 * restores them in paths.
 *
 * Filenames built entirely from ordinary words are left alone, and standard
 * tooling filenames are always preserved.
 */
function sandboxFilePath(relPath: string, ext: string, vault: Vault, kind: "mod" | "tbl" = "mod"): string {
  const slash = relPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : relPath.slice(0, slash + 1);
  const base = slash === -1 ? relPath : relPath.slice(slash + 1);
  const stem = base.slice(0, base.length - ext.length);

  if (INFRASTRUCTURE_FILENAMES.has(stem.toLowerCase())) return relPath;
  // A stem made only of ordinary words carries no organizational signal.
  if (!/[_]|[a-z][A-Z]/.test(stem)) return relPath;
  if (isStopword(stem)) return relPath;

  const token = vault.tokenize(stem, kind, "code").token;
  return `${dir}${token}${ext}`;
}

export async function buildSandbox(vault: Vault, options: BuildOptions): Promise<SandboxManifest> {
  const log = options.logger ?? (() => {});
  const realRoot = resolve(options.realRoot);
  const sandboxRoot = resolve(options.sandboxRoot);

  // Enforcement, not convention: refuse to mirror a repo into itself.
  const rel = relative(realRoot, sandboxRoot);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    throw new Error(
      `Refusing to build the sandbox inside the real repository.\n` +
        `  real:    ${realRoot}\n` +
        `  sandbox: ${sandboxRoot}\n` +
        `The cloud model runs with this directory as its working root, so it must ` +
        `not be able to reach the real tree by walking up.`,
    );
  }

  await rm(sandboxRoot, { recursive: true, force: true });
  await mkdir(sandboxRoot, { recursive: true });

  const exclude = new Set([...DEFAULT_EXCLUDE, ...(options.exclude ?? [])]);
  const maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES_DEFAULT;
  // Dataset entries are repo-relative paths, so they must be resolved against the
  // repository root. Resolving against the process working directory silently
  // matches nothing, which leaves every data file replaced by a placeholder and
  // hands the cloud model a repository with no data in it. Several entries may
  // target one source file, since a workbook or database holds many tables.
  const datasets = new Map<string, DatasetMockEntry[]>();
  const seenSandboxPaths = new Set<string>();
  for (const entry of options.datasets ?? []) {
    const key = resolve(realRoot, entry.realPath);
    const list = datasets.get(key) ?? [];
    list.push(entry);
    datasets.set(key, list);
    // Two sources can legitimately derive the same sandbox filename. Silently
    // writing both to one path loses a dataset from the cloud model's view, so
    // this is a hard error rather than a warning.
    if (seenSandboxPaths.has(entry.sandboxPath)) {
      throw new Error(
        `Duplicate sandbox path "${entry.sandboxPath}" for source "${entry.realPath}".\n` +
          `Each mocked dataset needs a distinct sandbox filename; disambiguate the sources.`,
      );
    }
    seenSandboxPaths.add(entry.sandboxPath);
  }

  const files: SandboxFile[] = [];
  const omissions: OmissionRecord[] = [];
  const mockData: MockDatasetRecord[] = [];

  await walk(realRoot, "");

  /**
   * `dir` is the absolute directory being read; `prefix` is its path relative
   * to the repository root. Keeping those separate is what stops the relative
   * path from being appended twice.
   */
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readDirEntries(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (exclude.has(entry.name)) {
        omissions.push({ path: relPath, reason: "excluded by name" });
        continue;
      }
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Credential stores are pruned wholesale before descending.
        if (isSecretDirectory(entry.name)) {
          omissions.push({ path: relPath, reason: "secret directory (never mirrored)" });
          continue;
        }
        // Datasets first: a directory with data files gets mocked wholesale.
        await walk(abs, relPath);
        continue;
      }
      if (!entry.isFile()) {
        omissions.push({ path: relPath, reason: "not a regular file" });
        continue;
      }
      if (isSecretFile(entry.name)) {
        omissions.push({ path: relPath, reason: "secret file (never mirrored)" });
        continue;
      }

      const ext = extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        omissions.push({ path: relPath, reason: `binary extension ${ext}` });
        continue;
      }
      const isDataFile = DATA_EXTENSIONS.has(ext);
      const mirroredPath = sandboxFilePath(relPath, ext, vault, isDataFile ? "tbl" : "mod");
      const target = join(sandboxRoot, ...mirroredPath.split("/"));

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      if (info.size > maxBytes) {
        omissions.push({ path: relPath, reason: `larger than ${maxBytes} bytes` });
        continue;
      }

      // Mocked dataset: write the synthetic rows, never the real ones.
      const datasetList = datasets.get(resolve(abs));
      if (datasetList && datasetList.length > 0) {
        for (const dataset of datasetList) {
          const datasetTarget = join(sandboxRoot, ...dataset.sandboxPath.split("/"));
          await writeMockFile(datasetTarget, dataset.sandboxPath, dataset, extname(dataset.sandboxPath));
          mockData.push({
            realPath: relPath,
            sandboxPath: dataset.sandboxPath,
            rows: dataset.rows.length,
            sourceRows: dataset.sourceRows,
            profile: dataset.profile,
          });
          files.push({
            path: dataset.sandboxPath,
            bytes: Buffer.byteLength(JSON.stringify(dataset.rows)),
            kind: "data",
          });
        }
        log(`  data  ${relPath} (${datasetList.length} table(s), ${datasetList[0]?.rows.length ?? 0} synthetic rows each)`);
        continue;
      }

      // Data files that were not explicitly mocked are replaced with a note
      // rather than copied. Silence here would be a leak.
      if (isDataFile) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          `# Mentat did not mirror this dataset.\n# Add it to the mock manifest to include a synthetic stand-in.\n`,
          "utf8",
        );
        omissions.push({ path: relPath, reason: "data file not in mock manifest" });
        continue;
      }

      const raw = await readFile(abs);
      if (looksBinary(raw)) {
        omissions.push({ path: relPath, reason: "binary content detected" });
        continue;
      }
      const text = raw.toString("utf8");
      const lang = languageFor(relPath);
      const isCode = CODE_EXTENSIONS.has(ext);
      const isConfig = CONFIG_EXTENSIONS.has(ext);
      const isDoc = DOC_EXTENSIONS.has(ext);

      // Prose-only formats are scrubbed wholesale; code and structured data go
      // through the segment-aware path so structure and string literals are
      // both handled. A plain vault lookup is not enough for either: it only
      // replaces names already in the vault, so an address, an email, or a
      // company name that has never appeared as an identifier would survive.
      const rewritten =
        options.proseRewrites?.[relPath] ??
        (isCode || isConfig
          ? sanitizeSource(text, lang, vault).text
          : scrubProse(text, vault).text);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, rewritten, "utf8");
      files.push({
        path: mirroredPath,
        bytes: Buffer.byteLength(rewritten),
        kind: isCode ? "code" : isConfig ? "config" : isDoc ? "doc" : "other",
        language: isCode || isDoc ? lang : undefined,
      });
      if (isCode) log(`  code  ${relPath}`);
    }
  }

  // Instructions for the cloud model.
  const vocab = vault.entries().map((e) => ({ token: e.token, kind: e.kind }));
  await writeFile(join(sandboxRoot, "AGENTS.md"), agentsInstructions(basename(sandboxRoot), vocab), "utf8");

  // Project scaffolding the agent expects.
  await writeFile(
    join(sandboxRoot, ".gitignore"),
    [".mentat-scratch/", "*.log", ".env", ".DS_Store"].join("\n") + "\n",
    "utf8",
  );

  // Nothing in the sandbox may reference the real tree.
  await writeFile(
    join(sandboxRoot, ".mentat-boundary.json"),
    JSON.stringify(
      {
        note: "This is a synthetic mirror. The real repository was never copied here.",
        mirroredFileCount: files.length,
        mockedDatasetCount: mockData.length,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const manifest: SandboxManifest = {
    createdAt: new Date().toISOString(),
    realRoot,
    sandboxRoot,
    files,
    mockData,
    tokenCount: vault.size,
    omissions,
  };

  // The full manifest names real paths and the real repository root, so it is
  // only ever written outside the sandbox. The sandbox always receives a
  // redacted summary; the full manifest is written to `manifestPath` when the
  // caller supplies one. Making the safe behaviour the default matters here,
  // because a caller that forgets to pass `manifestPath` would otherwise leak
  // every real filename into the directory the cloud model can read.
  if (options.manifestPath) {
    await writeFile(options.manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
  await writeFile(
    join(sandboxRoot, ".mentat-manifest.json"),
    JSON.stringify(
      {
        note: "Synthetic mirror. This file records sandbox-relative information only; the real repository was never copied here.",
        createdAt: manifest.createdAt,
        filesMirrored: files.length,
        filesOmitted: omissions.length,
        datasetsMocked: mockData.length,
        identifiersTokenized: vault.size,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return manifest;
}

async function writeMockFile(
  target: string,
  relPath: string,
  dataset: { readonly rows: readonly Record<string, unknown>[]; profile: string },
  ext: string,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const { serializeDelimited } = await import("../io/load.js");
  if (ext === ".json") {
    await writeFile(target, JSON.stringify(dataset.rows, null, 2), "utf8");
    return;
  }
  if (ext === ".jsonl" || ext === ".ndjson") {
    await writeFile(target, dataset.rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return;
  }
  if (ext === ".parquet" || ext === ".xlsx" || ext === ".db" || ext === ".sqlite" || ext === ".sqlite3") {
    // Binary formats are written by the Python sidecar; the rows are already
    // synthetic at this point, so they are written directly.
    const { writeDataset } = await import("../io/load.js");
    const fmt = ext === ".parquet" ? "parquet" : ext === ".xlsx" ? "xlsx" : "sqlite";
    await writeDataset(target, { name: basename(relPath, ext), format: fmt, rows: [], sheets: [] }, dataset.rows);
    return;
  }
  await writeFile(target, serializeDelimited(dataset.rows, ext === ".tsv" ? "\t" : ","), "utf8");
}

function isDataExtension(ext: string): boolean {
  return DATA_EXTENSIONS.has(ext);
}

/** NUL bytes in the first kilobyte are the reliable binary signal. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Lists files present in the sandbox that the mirror did not create. */
export async function collectNewFiles(sandboxRoot: string, known: ReadonlySet<string>): Promise<string[]> {
  if (!existsSync(sandboxRoot)) return [];
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readDirEntries(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
        continue;
      }
      if (!known.has(rel)) out.push(rel);
    }
  };
  await walk(sandboxRoot, "");
  return out.sort();
}