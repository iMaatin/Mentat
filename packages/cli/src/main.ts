#!/usr/bin/env node
/**
 * `mentat` command-line entry point.
 *
 * Commands are intentionally explicit about what they do and do not transmit,
 * because the user's mental model of a coding agent is "it sends things". Every
 * command that reaches the cloud layer prints what it is about to send and how
 * many bytes that is.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import {
  applyDiff,
  jobPaths,
  listJobs,
  loadVault,
  loadReport,
  parseDiff,
  pythonAvailable,
  removeJob,
  saveReport,
  scan,
  summarizeProfile,
  profileTable,
  readDataset,
  formatFor,
  supportsFormat,
  type JobReport,
  type ScanReport,
} from "@mentat/core";
import { LocalModel } from "@mentat/local";
import { findOpenCode } from "@mentat/cloud";
import { DEFAULT_CONFIG, loadConfig, jobsRoot, projectRootFor, sandboxBase } from "./config.js";
import { runPipeline } from "./pipeline.js";

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Flags whose value is the next argument. Only these consume a following
 * token — a boolean flag placed before the request (`ask --allow-egress "fix
 * the bug"`) must not swallow it.
 */
const VALUE_FLAGS = new Set(["cwd", "rows", "model", "local", "context"]);

function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i += 1;
        } else {
          flags[name] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
    i += 1;
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = new Proxy(C, { get: (t, k) => (useColor ? (t as Record<string, string>)[k as string] ?? "" : "") });

function out(line = ""): void {
  process.stdout.write(line + "\n");
}
function step(msg: string): void {
  out(`${c.cyan}▸${c.reset} ${msg}`);
}
function ok(msg: string): void {
  out(`${c.green}✓${c.reset} ${msg}`);
}
function warn(msg: string): void {
  out(`${c.yellow}!${c.reset} ${msg}`);
}
function fail(msg: string): void {
  process.stderr.write(`${c.red}✗${c.reset} ${msg}\n`);
}

/** Severity → color. Critical and high are both "stop and look"; low is context. */
function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return c.red + c.bold;
    case "high":
      return c.red;
    case "medium":
      return c.yellow;
    default:
      return c.dim;
  }
}

/** Status → color, shared by ask, list, and inspect. */
function paintStatus(status: string): string {
  const trimmed = status.trimEnd();
  if (trimmed === "failed") return c.red + status + c.reset;
  if (trimmed === "returned" || trimmed === "applied") return c.green + status + c.reset;
  return c.dim + status + c.reset;
}

/** A findings block: severity, rule, count, masked excerpt, advice. */
function renderFindings(report: ScanReport): string {
  return report.findings
    .map((f) =>
      [
        `  ${severityColor(f.severity)}${f.severity}${c.reset} ${c.bold}${f.rule}${c.reset} x${f.count}`,
        `      ${c.dim}${f.excerpt}${c.reset}`,
        `      ${c.dim}${f.advice}${c.reset}`,
      ].join("\n"),
    )
    .join("\n");
}

function confirm(question: string): Promise<boolean> {
  return new Promise<boolean>((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(/^(y|yes)$/i.test(answer.trim()));
    });
  });
}

/**
 * The egress review shown when a scan finds something in the outbound payload.
 * The user sees exactly what the gate saw — rule, severity, count, masked
 * excerpt — and decides. Non-interactive runs stay fail-closed unless
 * --allow-egress was given; either way the findings land in report.json.
 */
function makeEgressReviewer(autoApprove: boolean): (report: ScanReport) => Promise<boolean> {
  return async (report) => {
    out();
    warn(`egress review — the outbound payload contains ${report.findings.length} finding(s):`);
    out(renderFindings(report));
    out();
    if (autoApprove) {
      warn("sending anyway: --allow-egress was given (findings are recorded in report.json)");
      return true;
    }
    if (process.stdin.isTTY !== true) {
      out(`  ${c.dim}Not interactive. Re-run with --allow-egress to send these findings anyway.${c.reset}`);
      return false;
    }
    return await confirm(`  ${c.bold}Send to the cloud model anyway?${c.reset} [y/N] `);
  };
}

const HELP = `${c.bold}mentat${c.reset} — a two-layer coding agent that keeps your code on your machine.

${c.bold}USAGE${c.reset}
  mentat <command> [options]

${c.bold}COMMANDS${c.reset}
  ask "<request>"        Run the full pipeline on a request.
  init                   Create .mentat/config.json and .gitignore entries.
  doctor                 Check the local model, the opencode CLI, and formats.
  mock <path>            Profile a dataset and print a synthetic preview.
  inspect <job>          Show a past job: its report, egress scan, and diff.
  apply <job>            Restore tokens in a job's patch and write it to the repo.
  list                   List recorded jobs.
  clean [job]            Delete a job's artifacts (all jobs if no id given).
  scan <path>            Run the egress scanner over a file or directory.

${c.bold}OPTIONS for ask${c.reset}
  --apply                Write the restored patch to the real repository.
  --dry-run              Build the sandbox and stop. Touches no network.
  --rows <n>             Synthetic rows per dataset (default 200).
  --model <ref>          Cloud model, e.g. anthropic/claude-sonnet-4-5.
  --local <name>         Local model name in LM Studio.
  --prose                Also rewrite comments and docs via the local model.
  --no-local             Skip local model calls entirely (deterministic only).
  --context "<text>"     Extra context passed to the local rewriter.
  --allow-egress         Send even when the egress scan finds sensitive
                         content. Findings are shown for review and recorded.
                         Never applies to local-artifact references.
  --verbose              Stream cloud output and mirror every file.

${c.bold}ENVIRONMENT${c.reset}
  MENTAT_LOCAL_BASE_URL   Default http://127.0.0.1:1234/v1
  MENTAT_LOCAL_MODEL      Default qwen3-30b-a3b
  MENTAT_CLOUD_MODEL      Overrides the configured cloud model
  MENTAT_OPENCODE_BIN     Path to the opencode binary
  MENTAT_PYTHON           Python interpreter with pandas for parquet/xlsx/sqlite
  MENTAT_SANDBOX_ROOT     Where sandboxes live (never inside the repo)

${c.bold}HOW IT STAYS PRIVATE${c.reset}
  Your repository is never sent. Mentat builds a synthetic mirror outside your
  project, the cloud model edits only that mirror, and the result is mapped back
  by token substitution. Every outbound payload is scanned; anything real
  blocks the run unless you review the findings and approve them yourself.`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startDir = resolve(typeof args.flags.cwd === "string" ? args.flags.cwd : process.cwd());
  const projectRoot = projectRootFor(startDir);

  switch (args.command) {
    case "ask":
      return cmdAsk(args, projectRoot);
    case "init":
      return cmdInit(args, projectRoot);
    case "doctor":
      return cmdDoctor(projectRoot);
    case "mock":
      return cmdMock(args, projectRoot);
    case "inspect":
      return cmdInspect(args, projectRoot);
    case "apply":
      return cmdApply(args, projectRoot);
    case "list":
      return cmdList(projectRoot);
    case "clean":
      return cmdClean(args, projectRoot);
    case "scan":
      return cmdScan(args, projectRoot);
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return 0;
    case "version":
    case "--version":
      out("mentat 0.1.0");
      return 0;
    default:
      fail(`Unknown command: ${args.command}`);
      out(HELP);
      return 1;
  }
}

async function cmdAsk(args: Args, projectRoot: string): Promise<number> {
  const prompt = args.positional.join(" ").trim();
  if (!prompt) {
    fail('Give a request: mentat ask "add retry logic to the ingest job"');
    return 1;
  }

  const { config: loaded, path } = await loadConfig(projectRoot);
  const config = {
    ...loaded,
    cloudModel: typeof args.flags.model === "string" ? args.flags.model : loaded.cloudModel,
    localModel: typeof args.flags.local === "string" ? args.flags.local : loaded.localModel,
    mockRows: typeof args.flags.rows === "string" ? Number(args.flags.rows) : loaded.mockRows,
    verbose: args.flags.verbose === true || loaded.verbose,
    autoApply: args.flags.apply === true || loaded.autoApply,
  };
  if (path) step(`config ${c.dim}${path}${c.reset}`);

  const root = jobsRoot(projectRoot);

  out();
  out(`${c.bold}mentat${c.reset} ${c.dim}— sends only a synthetic mirror to the cloud${c.reset}`);
  out(`  ${c.dim}cloud${c.reset}  ${config.cloudModel}`);
  out(`  ${c.dim}local${c.reset}  ${config.localModel} ${c.dim}(LM Studio)${c.reset}`);
  out();

  const outcome = await runPipeline({
    projectRoot,
    jobsRoot: root,
    sandboxBase: sandboxBase(projectRoot),
    prompt,
    context: typeof args.flags.context === "string" ? args.flags.context : undefined,
    config,
    dryRun: args.flags["dry-run"] === true,
    apply: config.autoApply,
    rewriteProse: args.flags.prose === true,
    skipLocalModel: args.flags["no-local"] === true,
    reviewEgress: makeEgressReviewer(args.flags["allow-egress"] === true),
    logger: (m) => {
      if (m.startsWith("  ")) out(`  ${c.dim}${m.trim()}${c.reset}`);
      else step(m);
    },
  });

  out();
  const r = outcome.report;
  const line = (label: string, value: string): void => out(`${c.bold}${label.padEnd(8)}${c.reset} ${value}`);
  const egress = !r.egress
    ? c.dim + "not run" + c.reset
    : r.egress.ok
      ? c.green + "clean" + c.reset
      : r.egressApproved
        ? c.yellow + "APPROVED" + c.reset + c.dim + ` (${r.egress.findings.length} finding(s) reviewed)` + c.reset
        : c.red + "BLOCKED" + c.reset + c.dim + ` (${r.egress.findings.length} finding(s))` + c.reset;

  line("job", outcome.jobId);
  line("status", paintStatus(r.status));
  line("egress", egress);
  if (r.diffStat.files > 0) {
    line("changes", `${r.diffStat.files} file(s), +${r.diffStat.insertions} -${r.diffStat.deletions}`);
    if (!config.autoApply) {
      out(`  ${c.dim}not applied — review: mentat inspect ${outcome.jobId}${c.reset}`);
      out(`  ${c.dim}apply:   mentat apply ${outcome.jobId} --yes${c.reset}`);
    }
  }

  if (outcome.datasets.length > 0) {
    out();
    out(`${c.bold}datasets${c.reset}`);
    for (const d of outcome.datasets) {
      const misses = d.fidelity.filter((f) => !f.ok);
      const mark = misses.length === 0 ? c.green + "ok" + c.reset : c.yellow + `${misses.length} drift` + c.reset;
      out(`  ${d.realPath}:${d.table}  ${c.dim}${d.sourceRows} real → ${d.rows} synthetic (${mark})${c.reset}`);
    }
  }

  // On the blocked path the findings are printed here; on the approved path
  // the review already showed them, so the summary does not repeat them.
  if (r.egress && !r.egress.ok && !r.egressApproved) {
    out();
    out(`${c.red}egress findings${c.reset}`);
    out(renderFindings(r.egress));
  }

  if (outcome.cloudReply) {
    out();
    out(`${c.bold}cloud reply${c.reset}`);
    out(indent(outcome.cloudReply, "  "));
  }

  if (r.errors.length > 0) {
    out();
    out(`${c.yellow}notes${c.reset}`);
    for (const e of r.errors) out(`  ${c.dim}${e}${c.reset}`);
  }

  out();
  out(`${c.dim}artifacts: ${join(root, outcome.jobId)}${c.reset}`);
  return outcome.blocked || r.status === "failed" ? 1 : 0;
}

async function cmdInit(_args: Args, projectRoot: string): Promise<number> {
  const dir = join(projectRoot, ".mentat");
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, "config.json");
  const contents =
    `{\n` +
    `  "$schema": "https://mentat.local/config.schema.json",\n` +
    `  // Cloud layer. Must be a model opencode can reach and you can afford.\n` +
    `  "cloudModel": ${JSON.stringify(DEFAULT_CONFIG.cloudModel)},\n` +
    `  "cloudAgent": ${JSON.stringify(DEFAULT_CONFIG.cloudAgent)},\n` +
    `\n` +
    `  // Local layer. Runs on LM Studio; nothing leaves this machine.\n` +
    `  "localModel": ${JSON.stringify(DEFAULT_CONFIG.localModel)},\n` +
    `  "localBaseUrl": ${JSON.stringify(DEFAULT_CONFIG.localBaseUrl)},\n` +
    `\n` +
    `  // Mock data. Small on purpose; shape is what matters, not size.\n` +
    `  "mockRows": ${DEFAULT_CONFIG.mockRows},\n` +
    `  "seed": ${DEFAULT_CONFIG.seed},\n` +
    `\n` +
    `  // Always mock these dataset paths even outside the usual data directories.\n` +
    `  "dataGlobs": [],\n` +
    `\n` +
    `  // Additional names to exclude from the mirror.\n` +
    `  "exclude": [],\n` +
    `\n` +
    `  // Columns whose real values are replaced in generated data.\n` +
    `  "sensitiveColumns": ${JSON.stringify(DEFAULT_CONFIG.sensitiveColumns)}\n` +
    `}\n`;
  await writeFile(configPath, contents, "utf8");
  ok(`wrote ${c.dim}${relative(projectRoot, configPath)}${c.reset}`);

  const gitignore = join(projectRoot, ".gitignore");
  try {
    const existing = await readFile(gitignore, "utf8");
    if (!existing.includes(".mentat/")) {
      await writeFile(gitignore, `${existing.trimEnd()}\n\n# Mentat job artifacts: identifier maps and sandboxes. Never commit.\n.mentat/\n`, "utf8");
      ok(`appended .mentat/ to .gitignore`);
    } else {
      ok(`.gitignore already covers .mentat/`);
    }
  } catch {
    await writeFile(gitignore, "# Mentat job artifacts\n.mentat/\n", "utf8");
    ok(`created .gitignore`);
  }

  out();
  out(`Next: ${c.bold}mentat doctor${c.reset} to verify both layers are reachable.`);
  return 0;
}

async function cmdDoctor(projectRoot: string): Promise<number> {
  const { config } = await loadConfig(projectRoot);
  let failures = 0;

  out(`${c.bold}layer 1 — local model${c.reset}`);
  const local = new LocalModel({ model: config.localModel, baseUrl: config.localBaseUrl });
  const reach = await local.isReachable();
  if (reach.ok) {
    ok(`reachable at ${local.baseUrl}`);
    if (reach.models && reach.models.length > 0) {
      out(`  loaded: ${reach.models.join(", ")}`);
      if (!reach.models.includes(config.localModel)) {
        warn(`configured localModel "${config.localModel}" is not loaded`);
      }
    } else {
      warn("server is up but reports no models; load one in LM Studio");
      failures += 1;
    }
  } else {
    fail(reach.detail ?? "unreachable");
    failures += 1;
  }

  out();
  out(`${c.bold}layer 2 — cloud model via opencode${c.reset}`);
  const bin = findOpenCode();
  if (bin) {
    ok(`opencode at ${c.dim}${bin}${c.reset}`);
  } else {
    fail("opencode CLI not found (set MENTAT_OPENCODE_BIN)");
    failures += 1;
  }

  out();
  out(`${c.bold}datasets${c.reset}`);
  if (pythonAvailable()) {
    ok("python + pandas available (parquet, xlsx, sqlite)");
  } else {
    warn("no python with pandas; parquet, xlsx, and sqlite are unavailable");
    warn("  install: pip install pandas pyarrow openpyxl");
  }
  out(`  native: ${["csv", "tsv", "json", "jsonl"].filter((f) => supportsFormat(f as never)).join(", ")}`);

  out();
  out(`${c.bold}layout${c.reset}`);
  out(`  project     ${projectRoot}`);
  out(`  jobs        ${jobsRoot(projectRoot)}`);
  out(`  sandboxes   ${sandboxBase(projectRoot)}${sep}<job>`);

  out();
  if (failures > 0) {
    fail(`${failures} check(s) failed`);
    return 1;
  }
  ok("all layers ready");
  return 0;
}

function profileName(datasetName: string, tableName: string): string {
  // For a single-table source the two names are the same thing; concatenating
  // them produces "acme_acme", which is noise in every report.
  return datasetName === tableName ? datasetName : `${datasetName}_${tableName}`;
}

async function cmdMock(args: Args, projectRoot: string): Promise<number> {
  const target = args.positional[0];
  if (!target) {
    fail("Give a dataset path: mentat mock data/customers.csv");
    return 1;
  }
  const path = resolve(projectRoot, target);
  const format = formatFor(path);
  if (!supportsFormat(format)) {
    fail(`Unsupported format ${format}. Install pandas for parquet/xlsx/sqlite.`);
    return 1;
  }
  const { config } = await loadConfig(projectRoot);
  const rows = typeof args.flags.rows === "string" ? Number(args.flags.rows) : config.mockRows;

  const dataset = await readDataset(path, format);
  step(`profiling ${target}`);
  const { generateTable, redactCategories, compareProfiles, isSensitiveColumn, Rng } =
    await import("@mentat/core");
  const rng = new Rng(config.seed);

  if (dataset.sheets.length === 0) {
    warn("No readable tables in that file.");
    return 1;
  }

  for (const sheet of dataset.sheets) {
    if (sheet.rows.length === 0) {
      out(`${c.dim}(${sheet.name}: no rows)${c.reset}`);
      continue;
    }
    const profile = profileTable(profileName(dataset.name, sheet.name), sheet.rows, { seed: config.seed });
    if (dataset.sheets.length > 1) {
      out();
      out(`${c.bold}table ${sheet.name}${c.reset}`);
    }
    out(summarizeProfile(profile));
    out();

    const sensitive = profile.columns
      .filter((col) => isSensitiveColumn(col.name, config.sensitiveColumns))
      .map((col) => col.name);
    if (sensitive.length > 0) {
      out(`${c.dim}redacting columns: ${sensitive.join(", ")}${c.reset}`);
    }
    const { profile: safe } = redactCategories(profile, sensitive, rng);
    const generated = generateTable(safe, { rows, seed: config.seed });
    const fidelity = compareProfiles(safe, generated.profile);
    const misses = fidelity.filter((f) => !f.ok);

    out(`${c.bold}generated preview${c.reset} (${generated.rows.length} rows, first 5)`);
    out();
    const preview = generated.rows.slice(0, 5);
    if (preview.length > 0) out(indent(toTable(preview), "  "));
    out();
    out(`${c.bold}fidelity${c.reset} ${fidelity.length - misses.length}/${fidelity.length} checks within tolerance`);
    for (const m of misses.slice(0, 8)) {
      out(
        `  ${c.yellow}drift${c.reset} ${m.column}.${m.metric}: ` +
          `expected ${round(m.expected)}, got ${round(m.actual)} ` +
          `${c.dim}(${(m.delta * 100).toFixed(0)}% off)${c.reset}`,
      );
    }
    out();
  }

  out(`${c.dim}the mock is regenerated identically on every run (seed ${config.seed}).${c.reset}`);
  return 0;
}

async function cmdInspect(args: Args, projectRoot: string): Promise<number> {
  const id = args.positional[0];
  const root = jobsRoot(projectRoot);
  if (!id) {
    const jobs = await listJobs(root);
    if (jobs.length === 0) {
      out("No jobs recorded yet.");
      return 0;
    }
    out(`${c.bold}jobs${c.reset}`);
    for (const j of jobs) {
      const report = await loadReport(jobPaths(root, j));
      out(`  ${j}  ${paintStatus((report?.status ?? "unknown").padEnd(9))}`);
    }
    return 0;
  }

  const paths = jobPaths(root, id);
  const report = await loadReport(paths);
  if (!report) {
    fail(`No report for job ${id}`);
    return 1;
  }

  out(`${c.bold}job${c.reset} ${report.id}`);
  out(`  status      ${paintStatus(report.status)}`);
  out(`  started     ${report.startedAt}`);
  out(`  finished    ${report.finishedAt ?? "-"}`);
  out(`  cloud       ${report.cloudModel}`);
  out(`  local       ${report.localModel}`);
  out(`  files       ${report.filesMirrored} mirrored, ${report.filesOmitted} omitted`);
  out(`  identifiers ${report.tokensIntroduced} tokenized`);
  out(`  changes     ${report.diffStat.files} file(s), +${report.diffStat.insertions} -${report.diffStat.deletions}`);

  if (report.egress) {
    out();
    const verdict = report.egress.ok
      ? c.green + "clean" + c.reset
      : report.egressApproved
        ? c.yellow + "APPROVED" + c.reset + c.dim + " — findings reviewed and accepted by a human" + c.reset
        : c.red + "BLOCKED" + c.reset + c.dim + ` — ${report.egress.findings.length} finding(s)` + c.reset;
    out(`${c.bold}egress${c.reset}    ${verdict}`);
    if (!report.egress.ok) out(renderFindings(report.egress));
  }

  if (report.datasetsMocked.length > 0) {
    out();
    out(`${c.bold}mocked datasets${c.reset}`);
    for (const d of report.datasetsMocked) {
      out(`  ${d.realPath}  ${c.dim}${d.sourceRows} → ${d.rows}${c.reset}`);
    }
  }

  if (report.errors.length > 0) {
    out();
    out(`${c.yellow}notes${c.reset}`);
    for (const e of report.errors) out(`  ${e}`);
  }

  const patchExists = await readFile(paths.patch, "utf8").then(
    () => true,
    () => false,
  );
  if (patchExists) {
    out();
    out(`${c.bold}restored patch${c.reset} ${c.dim}${paths.patch}${c.reset}`);
    const raw = await readFile(paths.patch, "utf8");
    // The file on disk is the raw sandbox diff (tokens intact — `mentat apply`
    // restores while writing). The review surface shows it restored, which is
    // what the label promises and what a human reviewer needs to read.
    let shown = raw;
    try {
      shown = (await loadVault(paths)).restore(raw);
    } catch {
      // No vault (hand-edited job directory): the raw diff is still informative.
    }
    out(indent(shown.split("\n").slice(0, 40).join("\n"), "  "));
    if (shown.split("\n").length > 40) out(`  ${c.dim}... truncated${c.reset}`);
  }

  out();
  out(`${c.dim}identifier map (never shared): ${paths.vault}${c.reset}`);
  return 0;
}

async function cmdApply(args: Args, projectRoot: string): Promise<number> {
  const id = args.positional[0];
  if (!id) {
    fail("Give a job id: mentat apply 20260101-142233-a7f");
    return 1;
  }
  const root = jobsRoot(projectRoot);
  const paths = jobPaths(root, id);

  const report = await loadReport(paths);
  if (!report) {
    fail(`No report for job ${id}`);
    return 1;
  }

  // The patch file is the source of truth, not the report's summary counters.
  // Trusting the counters means a job whose report was written before the diff
  // was collected silently reports "no changes" instead of applying real work.
  let raw: string;
  try {
    raw = await readFile(paths.patch, "utf8");
  } catch {
    warn(`Job ${id} has no recorded patch.`);
    return 1;
  }
  if (raw.trim() === "") {
    warn(`Job ${id} produced an empty patch: the cloud model changed nothing.`);
    return 0;
  }
  const parsed = parseDiff(raw);
  if (parsed.files.length === 0) {
    warn(`Job ${id} patch contained no file changes.`);
    return 0;
  }

  out(`${c.bold}job${c.reset} ${id}`);
  out(`  files      ${parsed.files.length}`);
  out(`  inserts    ${report.diffStat.insertions}`);
  out(`  deletes    -${report.diffStat.deletions}`);
  out(`  tokens     ${(await loadVault(paths)).size} to restore`);
  out();

  if (args.flags.dryRun === true) {
    out(`${c.dim}dry run; pass --yes to write${c.reset}`);
  }

  const shouldWrite = args.flags.yes === true || args.flags.apply === true;
  if (!shouldWrite) {
    out(`This will modify your working tree in ${projectRoot}.`);
    out(`Review with ${c.bold}mentat inspect ${id}${c.reset}, then re-run with ${c.bold}--yes${c.reset}.`);
    return 1;
  }

  // The vault is what turns cloud tokens back into real identifiers. Loading it
  // here, and only here, keeps the reverse map out of every other code path.
  const vault = await loadVault(paths);
  const result = await applyDiff(parsed, projectRoot, vault, {
    write: true,
    logger: (m) => out(`  ${c.dim}${m.trim()}${c.reset}`),
  });

  out();
  const applied = result.files.filter((f) => f.status === "applied").length;
  const skipped = result.files.filter((f) => f.status === "skipped").length;
  const failed = result.files.filter((f) => f.status === "failed");

  if (applied > 0) ok(`${applied} file(s) written`);
  if (skipped > 0) warn(`${skipped} file(s) partially applied`);
  for (const f of failed) fail(`${f.path}: ${f.note ?? "could not apply"}`);

  if (failed.length > 0) {
    out();
    out(
      `${c.dim}Unapplied hunks need reconciliation. mentat keeps the sandbox at\n` +
        `${paths.sandbox}\n` +
        `so you can compare a file directly against what the cloud model produced.${c.reset}`,
    );
  }

  report.status = failed.length === 0 ? "applied" : report.status;
  report.finishedAt = report.finishedAt ?? new Date().toISOString();
  await saveReport(paths, report);
  return failed.length === 0 ? 0 : 1;
}

async function cmdList(projectRoot: string): Promise<number> {
  const root = jobsRoot(projectRoot);
  const jobs = await listJobs(root);
  if (jobs.length === 0) {
    out("No jobs recorded yet.");
    return 0;
  }
  out(`${c.bold}jobs${c.reset}`);
  for (const j of jobs) {
    const report = await loadReport(jobPaths(root, j));
    const status = (report?.status ?? "?").padEnd(9);
    out(`  ${j}  ${paintStatus(status)}${report ? `  ${report.diffStat.files} file(s)` : ""}`);
  }
  return 0;
}

async function cmdClean(args: Args, projectRoot: string): Promise<number> {
  const root = jobsRoot(projectRoot);
  const id = args.positional[0];
  if (id) {
    await removeJob(root, id);
    ok(`removed job ${id}`);
    return 0;
  }
  const jobs = await listJobs(root);
  if (jobs.length === 0) {
    out("Nothing to clean.");
    return 0;
  }
  if (args.flags.yes !== true) {
    out(`This will delete ${jobs.length} job(s) under ${root}, including identifier maps.`);
    out(`Re-run with ${c.bold}--yes${c.reset} to confirm.`);
    return 1;
  }
  for (const j of jobs) await removeJob(root, j);
  ok(`removed ${jobs.length} job(s)`);
  return 0;
}

async function cmdScan(args: Args, projectRoot: string): Promise<number> {
  const target = args.positional[0];
  if (!target) {
    fail("Give a file or directory: mentat scan src/");
    return 1;
  }
  const path = resolve(projectRoot, target);
  const root = jobsRoot(projectRoot);
  // Reuse the most recent job's vault, since that is the set of real names.
  const jobs = await listJobs(root);
  if (jobs.length === 0) {
    fail("No vault available yet. Run `mentat ask` once, or `mentat init` + a mock run first.");
    return 1;
  }
  const vault = await loadVault(jobPaths(root, jobs[0] as string));
  const text = await readFile(path, "utf8");
  const report = scan(text, vault, { redact: true });
  if (report.ok) {
    out(`${c.green}✓${c.reset} clean — ${report.rulesRun.length} rules, 0 findings`);
  } else {
    out(`${c.red}✗${c.reset} ${report.findings.length} finding(s) in ${target}`);
    out(renderFindings(report));
  }
  return report.ok ? 0 : 1;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => `${prefix}${l}`)
    .join("\n");
}

function round(n: number): string {
  return Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2);
}

function toTable(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no rows)";
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const cells = rows.map((r) => headers.map((h) => cell(r[h])));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  const line = (vals: readonly string[]): string =>
    vals.map((v, i) => (v ?? "").padEnd(widths[i] ?? 0)).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "Error";
    fail(`${name}: ${message}`);
    if (process.env.MENTAT_DEBUG === "1" && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exitCode = 1;
  });

export type { JobReport };