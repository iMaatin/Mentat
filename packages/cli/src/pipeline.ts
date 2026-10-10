/**
 * The Mentat pipeline.
 *
 * Four stages, each with an explicit boundary:
 *
 *   1. INVENTORY  Scan the repo. Build the vault. Profile every dataset.
 *                 Everything from here is local-only.
 *   2. SANDBOX   Build the synthetic mirror outside the repo. Generate mocks.
 *                 The real repo is never readable from the sandbox root.
 *   3. DELEGATE  Rewrite the prompt locally, scan the payload, then hand it to
 *                 the cloud model running against the sandbox.
 *   4. ADAPT     Diff the sandbox against its baseline, restore every token,
 *                 apply to the real repo.
 *
 * The ordering is the security property. Any stage that produces something
 * outbound runs its egress check immediately before the network boundary, not
 * once at the start.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import {
  Vault,
  buildSandbox,
  collectSandboxDiff,
  compareProfiles,
  ensureJobRoot,
  formatReport,
  generateTable,
  initSandboxBaseline,
  isSensitiveColumn,
  jobPaths,
  loadVault,
  newJobId,
  parseDiff,
  profileTable,
  applyDiff,
  readDataset,
  redactCategories,
  saveReport,
  saveVault,
  sanitizeSource,
  scan,
  summarizeProfile,
  assertNotExfiltrated,
  Rng,
  type DatasetMockEntry,
  type JobReport,
  type SandboxManifest,
  type TableProfile,
} from "@mentat/core";
import { LocalModel, extractTerms, redactProse, rewritePrompt, describeDataset } from "@mentat/local";
import { delegate, finalText } from "@mentat/cloud";
import type { MentatConfig } from "./config.js";

export interface RunOptions {
  readonly projectRoot: string;
  readonly jobsRoot: string;
  /** Parent directory for sandboxes. The job id is appended by the pipeline. */
  readonly sandboxBase: string;
  readonly prompt: string;
  readonly context?: string;
  readonly config: MentatConfig;
  readonly logger?: (message: string) => void;
  /** Stop after building the sandbox; useful for inspecting the mock. */
  readonly dryRun?: boolean;
  /** Apply the resulting patch to the real repo. */
  readonly apply?: boolean;
  /** Ask the local model to rewrite comments and prose in the sandbox. */
  readonly rewriteProse?: boolean;
  readonly skipLocalModel?: boolean;
}

export interface RunOutcome {
  readonly jobId: string;
  readonly report: JobReport;
  readonly sandboxManifest: SandboxManifest | null;
  readonly datasets: readonly DatasetMock[];
  readonly cloudReply: string | null;
  readonly blocked: string | null;
}

export interface DatasetMock {
  readonly realPath: string;
  readonly table: string;
  readonly rows: number;
  readonly sourceRows: number;
  readonly profile: TableProfile;
  readonly fidelity: readonly { column: string; metric: string; expected: number; actual: number; delta: number; ok: boolean }[];
}

const DATA_EXTENSIONS = new Set([
  ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet", ".xlsx", ".xls", ".db", ".sqlite", ".sqlite3",
]);

function isDataPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return DATA_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export async function runPipeline(options: RunOptions): Promise<RunOutcome> {
  const log = options.logger ?? (() => {});
  const errors: string[] = [];
  const jobId = newJobId();
  const paths = jobPaths(options.jobsRoot, jobId);
  await ensureJobRoot(options.jobsRoot);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.prompt, options.prompt, "utf8");

  const projectRoot = resolve(options.projectRoot);
  // The sandbox is namespaced by job id so concurrent runs never collide, and
  // so a job's sandbox can be found again for inspection.
  const sandboxRoot = resolve(join(options.sandboxBase, jobId));
  const vault = new Vault();

  const report: JobReport = {
    id: jobId,
    startedAt: new Date().toISOString(),
    status: "created",
    realRoot: projectRoot,
    cloudModel: options.config.cloudModel,
    localModel: options.config.localModel,
    filesMirrored: 0,
    filesOmitted: 0,
    datasetsMocked: [],
    tokensIntroduced: 0,
    egress: null,
    diffStat: { files: 0, insertions: 0, deletions: 0 },
    errors,
  };

  // ---------------------------------------------------------------- stage 1
  log("inventing the repository");
  const local = options.skipLocalModel ? null : new LocalModel({ model: options.config.localModel, baseUrl: options.config.localBaseUrl });

  if (local) {
    const reach = await local.isReachable();
    if (!reach.ok) {
      errors.push(`Local model unavailable: ${reach.detail ?? "unknown"}`);
      log(`  local model not reachable (${local.baseUrl}); continuing without semantic rewriting.`);
    } else if (reach.models && !reach.models.includes(options.config.localModel)) {
      log(`  note: configured model "${options.config.localModel}" is not among loaded models: ${reach.models.join(", ")}`);
    }
  }

  // Profile and mock every dataset before the sandbox is built, so the sandbox
  // writer only has to copy results.
  log("profiling datasets");
  const datasetMocks: DatasetMock[] = [];
  const datasetPayloads: DatasetMockEntry[] = [];
  /** Sandbox paths already taken, so a second source cannot overwrite the first. */
  const claimedSandboxPaths = new Set<string>();
  const rng = new Rng(options.config.seed);

  const datasetPaths = await findDatasets(projectRoot, options.config.dataGlobs, options.config.exclude);
  for (const relPath of datasetPaths) {
    try {
      const dataset = await readDataset(join(projectRoot, ...relPath.split("/")));

      // A workbook or a database holds several tables. Each one is profiled and
      // mocked separately, and each becomes its own file in the sandbox.
      for (const sheet of dataset.sheets) {
        if (sheet.rows.length === 0) {
          log(`  skip ${relPath}:${sheet.name} (no rows)`);
          continue;
        }
        const profile = profileTable(
          dataset.name === sheet.name ? dataset.name : `${dataset.name}_${sheet.name}`,
          sheet.rows,
          { seed: options.config.seed },
        );
        const sensitive = profile.columns
          .filter((c) => isSensitiveColumn(c.name, options.config.sensitiveColumns))
          .map((c) => c.name);

        const { profile: safeProfile } = redactCategories(profile, sensitive, rng);
        const generated = generateTable(safeProfile, {
          rows: options.config.mockRows,
          seed: options.config.seed,
        });
        const fidelity = compareProfiles(safeProfile, generated.profile);
        datasetMocks.push({
          realPath: relPath,
          table: sheet.name,
          rows: generated.rows.length,
          sourceRows: sheet.rows.length,
          profile: safeProfile,
          fidelity,
        });

        // Sandbox files are always CSV. The mock has no reason to inherit the
        // source's binary format, and CSV keeps the sandbox readable and small.
        // Names are disambiguated against paths already claimed: `acme.db` and
        // `acme.parquet` in `raw/` both want `raw/acme.csv`, and a silent
        // overwrite would drop a dataset from the cloud model's view with no
        // visible error anywhere.
        const dir = relPath.includes("/") ? `${relPath.slice(0, relPath.lastIndexOf("/"))}/` : "";
        const stem = relPath.slice(dir.length).replace(/\.[^.]+$/, "");
        const tableToken = dataset.sheets.length > 1 ? `_${vault.tokenize(sheet.name, "tbl", "data").token}` : "";
        let sandboxPath = `${dir}${stem}${tableToken}.csv`;
        if (claimedSandboxPaths.has(sandboxPath)) {
          const sourceExt = relPath.slice(relPath.lastIndexOf("."));
          sandboxPath = `${dir}${stem}${tableToken}_${vault.tokenize(sourceExt, "mod", "code").token}.csv`;
        }
        claimedSandboxPaths.add(sandboxPath);

        datasetPayloads.push({
          realPath: relPath,
          sandboxPath,
          rows: generated.rows as Record<string, unknown>[],
          profile: summarizeProfile(safeProfile),
          sourceRows: sheet.rows.length,
        });
        log(
          `  mock ${relPath}${dataset.sheets.length > 1 ? `:${sheet.name}` : ""} ` +
            `(${sheet.rows.length} real rows -> ${generated.rows.length} synthetic, ` +
            `${fidelity.filter((f) => !f.ok).length} fidelity misses)`,
        );
      }
    } catch (err) {
      errors.push(`Could not mock ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      log(`  skip ${relPath} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Ask the local model for proprietary terms in the highest-signal source files.
  if (local) {
    const probes = await pickProbeFiles(projectRoot, options.config.exclude);
    for (const relPath of probes) {
      try {
        const source = await readFile(join(projectRoot, ...relPath.split("/")), "utf8");
        const { terms } = await extractTerms(local, source, relPath);
        for (const term of terms) {
          if (!vault.has(term)) vault.tokenize(term, "org", "text");
        }
        if (terms.length > 0) log(`  terms ${relPath}: ${terms.length}`);
      } catch {
        // A failed probe must not stall the run; deterministic tokenization
        // still runs during the sandbox build.
      }
    }
  }

  // ---------------------------------------------------------------- stage 2
  log("building the sandbox");
  let proseRewrites: Record<string, string> | undefined;
  if (options.rewriteProse && local) {
    proseRewrites = await buildProseRewrites(local, projectRoot, options.config);
  }

  const manifest = await buildSandbox(vault, {
    realRoot: projectRoot,
    sandboxRoot,
    datasets: datasetPayloads,
    exclude: options.config.exclude,
    proseRewrites,
    // The full manifest records real paths, so it belongs beside the vault in
    // the job directory rather than inside the sandbox the cloud model reads.
    manifestPath: paths.staging,
    logger: options.config.verbose ? log : undefined,
  });
  report.filesMirrored = manifest.files.length;
  report.filesOmitted = manifest.omissions.length;
  report.datasetsMocked = manifest.mockData.map((m) => ({
    realPath: m.realPath,
    rows: m.rows,
    sourceRows: m.sourceRows,
  }));
  report.tokensIntroduced = vault.size;
  report.status = "sandboxed";
  await saveVault(paths, vault);
  await saveReport(paths, report);

  const baseline = await initSandboxBaseline(sandboxRoot);
  if (!baseline.ok) errors.push(`Sandbox baseline commit failed: ${baseline.error}`);

  if (options.dryRun) {
    report.status = "sandboxed";
    report.finishedAt = new Date().toISOString();
    await saveReport(paths, report);
    return { jobId, report, sandboxManifest: manifest, datasets: datasetMocks, cloudReply: null, blocked: null };
  }

  // ---------------------------------------------------------------- stage 3
  log("rewriting the prompt for the cloud");
  let task = options.prompt;
  if (local) {
    try {
      const rewritten = await rewritePrompt(local, options.prompt, options.context);
      task = rewritten.prompt;
      if (rewritten.generalized.length > 0) {
        log(`  generalized ${rewritten.generalized.length} domain terms`);
      }
    } catch (err) {
      errors.push(`Prompt rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The sanitized prompt is what is sent; record it beside the original so the
  // two can be diffed later.
  assertNotExfiltrated(task);
  await writeFile(paths.promptSanitized, task, "utf8");

  const promptPreview = scan(task, vault, { redact: true });
  if (!promptPreview.ok) {
    const blocked = `Prompt still contains ${promptPreview.findings.length} sensitive token(s) after local rewriting. Refusing to send.`;
    errors.push(blocked);
    report.egress = promptPreview;
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    await saveReport(paths, report);
    return { jobId, report, sandboxManifest: manifest, datasets: datasetMocks, cloudReply: null, blocked };
  }

  log("delegating to the cloud layer");
  const delegation = await delegate({
    sandboxRoot,
    prompt: task,
    vault,
    config: { model: options.config.cloudModel, agent: options.config.cloudAgent, standalone: false },
    logger: log,
    verbose: options.config.verbose,
  });
  report.egress = delegation.egress;

  if (delegation.blocked) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    errors.push(delegation.blocked);
    await saveReport(paths, report);
    return { jobId, report, sandboxManifest: manifest, datasets: datasetMocks, cloudReply: null, blocked: delegation.blocked };
  }

  if (!delegation.ok) {
    report.status = "failed";
    report.finishedAt = new Date().toISOString();
    errors.push(`Cloud run exited ${delegation.exitCode}: ${delegation.stderr.slice(0, 800)}`);
    await saveReport(paths, report);
    return { jobId, report, sandboxManifest: manifest, datasets: datasetMocks, cloudReply: finalText(delegation.events), blocked: null };
  }

  const reply = finalText(delegation.events);
  report.status = "returned";

  // ---------------------------------------------------------------- stage 4
  log("adapting the result back to the real repository");
  const rawDiff = await collectSandboxDiff(sandboxRoot);
  await writeFile(paths.patch, rawDiff, "utf8");
  const parsed = parseDiff(rawDiff);
  report.diffStat = diffStat(parsed.raw);

  if (parsed.files.length === 0) {
    log("  the cloud model made no filesystem changes");
    report.finishedAt = new Date().toISOString();
    await saveReport(paths, report);
    return { jobId, report, sandboxManifest: manifest, datasets: datasetMocks, cloudReply: reply, blocked: null };
  }

  const applied = await applyDiff(parsed, projectRoot, vault, { write: options.apply === true, logger: log });
  if (!applied.ok) {
    errors.push(`${applied.files.filter((f) => f.status === "failed").length} file(s) could not be applied and need reconciliation.`);
  }
  if (options.apply !== true) {
    log("  dry run: not writing to the real repository (pass --apply to write)");
  }
  report.status = options.apply === true ? "applied" : "returned";
  report.finishedAt = new Date().toISOString();
  await saveReport(paths, report);

  return { jobId, report, sandboxManifest: manifest, datasets: datasetMocks, cloudReply: reply, blocked: null };
}

function diffStat(raw: string): { files: number; insertions: number; deletions: number } {
  const parsed = parseDiff(raw);
  let insertions = 0;
  let deletions = 0;
  for (const file of parsed.files) {
    for (const line of file.hunks) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  return { files: parsed.files.length, insertions, deletions };
}

/** Locates datasets under the project root, honouring config globs. */
async function findDatasets(projectRoot: string, globs: readonly string[], exclude: readonly string[]): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const found: string[] = [];
  const skip = new Set([...exclude, "node_modules", ".git", ".mentat", "dist", "build", "__pycache__", ".venv"]);

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
      if (skip.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isDataPath(rel)) continue;
      // Respect an explicit config glob if one covers this path.
      if (globs.length > 0 && !matchesAnyGlob(rel, globs)) continue;
      try {
        const info = await stat(abs);
        if (info.size > 0) found.push(rel);
      } catch {
        continue;
      }
    }
  };
  await walk(projectRoot, "");
  return found.sort();
}

function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  const normalized = path.toLowerCase();
  return globs.some((g) => {
    const pattern = g.toLowerCase().replace(/\*\*\//g, "").replaceAll("*", "");
    return normalized.includes(pattern);
  });
}

/** Picks a handful of source files to probe the local model for domain terms. */
async function pickProbeFiles(projectRoot: string, exclude: readonly string[]): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const skip = new Set([...exclude, "node_modules", ".git", ".mentat", "dist", "build"]);
  const candidates: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 4 || candidates.length >= 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
      if (skip.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel, depth + 1);
        continue;
      }
      if (entry.isFile() && /\.(ts|js|py|go|rs|java|sql)$/i.test(entry.name)) candidates.push(rel);
      if (candidates.length >= 8) return;
    }
  };
  await walk(projectRoot, "", 0);
  // Largest files first: they carry the most domain vocabulary.
  return candidates.slice(0, 8);
}

async function buildProseRewrites(
  local: LocalModel,
  projectRoot: string,
  config: MentatConfig,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const files = await pickProbeFiles(projectRoot, config.exclude);
  for (const rel of files.slice(0, 4)) {
    try {
      const source = await readFile(join(projectRoot, ...rel.split("/")), "utf8");
      const prose = extractProseBlocks(source);
      if (prose.trim().length === 0) continue;
      out[rel] = await redactProse(local, prose);
    } catch {
      continue;
    }
  }
  return out;
}

/** Pulls comment and docstring text out of a source file for the local model. */
function extractProseBlocks(source: string): string {
  const blocks: string[] = [];
  const comment = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|^\s*#[^\n]*|\"\"\"[\s\S]*?\"\"\"/gm;
  let match = comment.exec(source);
  while (match !== null) {
    const block = match[0].trim();
    // Only send blocks that carry words worth redacting.
    if (block.replace(/\W/g, "").length > 25) blocks.push(block);
    match = comment.exec(source);
  }
  return blocks.join("\n\n");
}

export { sanitizeSource, loadVault, describeDataset, formatReport };