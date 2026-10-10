/**
 * Job state.
 *
 * A job is one complete Mentat run. Everything it produced lives under
 * `.mentat/jobs/<id>/`, and the directory layout is the audit trail:
 *
 *   prompt.txt        your original request, verbatim
 *   prompt.sanitized  the de-identified request the cloud model received
 *   vault.json        the identifier map. Never leaves this directory.
 *   sandbox/          the synthetic mirror the cloud model edited
 *   result.patch      tokens restored, ready to apply to the real repo
 *   report.json       what happened: token counts, egress scan, diff stat
 *
 * `vault.json` and `sandbox/` are the sensitive parts. `.mentat/` is gitignored
 * by `mentat init`, and `assertNotExfiltrated` is the runtime guard that keeps
 * those paths out of any outbound payload.
 */

import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Vault, type VaultEntry } from "../vault/Vault.js";
import type { ScanReport } from "../scan/scan.js";

export interface JobPaths {
  readonly root: string;
  readonly prompt: string;
  readonly promptSanitized: string;
  readonly vault: string;
  readonly sandbox: string;
  readonly patch: string;
  readonly report: string;
  readonly staging: string;
}

/**
 * Mutable by design: a report is a working document that the pipeline fills in
 * as it advances through the stages, and it is persisted at each transition so
 * a crash still leaves an accurate record.
 */
export interface JobReport {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "created" | "sandboxed" | "delegated" | "returned" | "applied" | "failed";
  realRoot: string;
  cloudModel: string;
  localModel: string;
  filesMirrored: number;
  filesOmitted: number;
  datasetsMocked: { realPath: string; rows: number; sourceRows: number }[];
  tokensIntroduced: number;
  egress: ScanReport | null;
  diffStat: { files: number; insertions: number; deletions: number };
  errors: string[];
}

export function jobPaths(jobRoot: string, id: string): JobPaths {
  const root = join(jobRoot, id);
  return {
    root,
    prompt: join(root, "prompt.txt"),
    promptSanitized: join(root, "prompt.sanitized"),
    vault: join(root, "vault.json"),
    sandbox: join(root, "sandbox"),
    patch: join(root, "result.patch"),
    report: join(root, "report.json"),
    staging: join(root, "staging"),
  };
}

/** Monotonic, sortable, and readable. Time-ordered so `ls` sorts by recency. */
export function newJobId(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(3, "0");
  return `${stamp}-${suffix}`;
}

export async function ensureJobRoot(jobRoot: string): Promise<string> {
  await mkdir(resolve(jobRoot), { recursive: true });
  return resolve(jobRoot);
}

export async function saveVault(paths: JobPaths, vault: Vault): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  // Written with restricted permissions where the platform allows it: this file
  // is the reverse map, and it is the one artifact that must never be shared.
  const json = JSON.stringify({ entries: vault.toJSON() satisfies VaultEntry[] }, null, 2) + "\n";
  await writeFile(paths.vault, json, { encoding: "utf8", mode: 0o600 });
}

export async function loadVault(paths: JobPaths): Promise<Vault> {
  const raw = await readFile(paths.vault, "utf8");
  const parsed = JSON.parse(raw) as { entries: VaultEntry[] };
  return new Vault(parsed.entries ?? []);
}

export async function saveReport(paths: JobPaths, report: JobReport): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.report, JSON.stringify(report, null, 2) + "\n", "utf8");
}

export async function loadReport(paths: JobPaths): Promise<JobReport | null> {
  try {
    return JSON.parse(await readFile(paths.report, "utf8")) as JobReport;
  } catch {
    return null;
  }
}

export async function listJobs(jobRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(jobRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function removeJob(jobRoot: string, id: string): Promise<void> {
  const root = resolve(jobRoot);
  const target = resolve(join(root, id));
  // Containment by `relative`, not by prefix. A `startsWith` test passes for a
  // sibling directory whose name extends the root's own name —
  // `…/.mentat/jobs-evil` starts with `…/.mentat/jobs` — which let
  // `mentat clean ../jobs-evil` delete outside the job root. A relative path
  // that escapes the root, or addresses the root itself, is refused.
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("refusing to delete outside the job root");
  }
  await rm(target, { recursive: true, force: true });
}

/**
 * Paths that must never appear in an outbound payload. Checked by the egress
 * layer in addition to content scanning, so that a mistake in path handling
 * fails closed.
 *
 * Patterns are anchored to path starts rather than matched as raw substrings.
 * The raw substring "sandbox/" fired on any repository that happens to keep a
 * real `sandbox/` directory — a very common project layout — so every `ask`
 * that mentioned a file under it was blocked. The anchored form still matches
 * the path at a segment boundary (start of payload, after whitespace, a quote,
 * or a path separator) while leaving `mysandbox/…` and `my.sandbox/…` alone.
 */
export const FORBIDDEN_OUTBOUND: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_.\-])\.mentat[\\/]/,
  /(?:^|[^A-Za-z0-9_\-])vault\.json/,
  /(?:^|[^A-Za-z0-9_\-])prompt\.txt/,
  /(?:^|[^A-Za-z0-9_.\-])sandbox[\\/]/,
];

export class BoundaryViolation extends Error {
  readonly offending: string;
  constructor(offending: string) {
    super(
      `Refusing to send: the payload references local-only artifact ${offending}.\n` +
        `This is a Mentat invariant violation, not a warning.`,
    );
    this.name = "BoundaryViolation";
    this.offending = offending;
  }
}

/** Fails closed when a payload names anything that stays local. */
export function assertNotExfiltrated(payload: string): void {
  for (const forbidden of FORBIDDEN_OUTBOUND) {
    const match = forbidden.exec(payload);
    if (match) throw new BoundaryViolation(match[0].trim());
  }
}