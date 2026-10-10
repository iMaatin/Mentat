/**
 * Layer 3: applying the cloud model's work to the real repository.
 *
 * The cloud model edits files in the sandbox. We take that diff, restore every
 * token to its real identifier, and apply it to the real tree.
 *
 * Applying a restored patch with `git apply` is exact when the mock is faithful,
 * because token substitution preserves line count, indentation, and structure.
 * Where it fails, the patch is applied hunk by hunk with context shifting, and
 * anything still unresolved is reported for the local model to reconcile rather
 * than being forced.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Vault } from "../vault/Vault.js";

export interface DiffFile {
  /** Path as recorded in the diff, relative to the repository root. */
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  /** Unified diff hunks, with tokens already restored. */
  readonly hunks: readonly string[];
  readonly originalPath?: string;
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
  readonly raw: string;
}

/** Parses `git diff` output into per-file hunk groups. */
export function parseDiff(raw: string): ParsedDiff {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let current: { path: string; status: DiffFile["status"]; hunks: string[]; originalPath?: string } | null = null;
  let inHunk = false;

  const flush = (): void => {
    if (!current) return;
    files.push({
      path: current.path,
      status: current.status,
      hunks: current.hunks,
      ...(current.originalPath ? { originalPath: current.originalPath } : {}),
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = {
        path: m?.[2] ?? "",
        status: "modified",
        hunks: [],
      };
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.originalPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      current.hunks.push(line);
      continue;
    }
    if (inHunk) {
      if (line.startsWith("\\")) continue;
      current.hunks.push(line);
    }
  }
  flush();
  return { files, raw };
}

/**
 * Applies restored hunks to a file by matching context, tolerating the small
 * offsets that arise when the real file differs slightly from the mock.
 */
export function applyHunks(original: readonly string[], hunks: readonly string[]): {
  lines: string[];
  applied: number;
  failed: number;
} {
  let out = original.slice();
  let applied = 0;
  let failed = 0;
  let searchFrom = 0;

  const grouped = groupHunks(hunks);
  for (const hunk of grouped) {
    const oldLines = hunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).map((l) => l.slice(1));
    const newLines = hunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).map((l) => l.slice(1));

    let at = findSequence(out, oldLines, searchFrom);
    if (at === -1 && searchFrom > 0) at = findSequence(out, oldLines, 0);
    if (at === -1) {
      failed += 1;
      continue;
    }
    out = [...out.slice(0, at), ...newLines, ...out.slice(at + oldLines.length)];
    searchFrom = at + newLines.length;
    applied += 1;
  }
  return { lines: out, applied, failed };
}

interface Hunk {
  readonly header: string;
  readonly lines: readonly string[];
}

function groupHunks(hunks: readonly string[]): Hunk[] {
  const out: Hunk[] = [];
  let current: { header: string; lines: string[] } | null = null;
  for (const line of hunks) {
    if (line.startsWith("@@")) {
      if (current) out.push(current);
      current = { header: line, lines: [] };
      continue;
    }
    if (!current) continue;
    if (line === "" && current.lines.length === 0) continue;
    current.lines.push(line);
  }
  if (current) out.push(current);
  return out;
}

/** First index at which `needle` occurs in `haystack`, or -1. */
function findSequence(haystack: readonly string[], needle: readonly string[], from: number): number {
  if (needle.length === 0) return Math.min(from, haystack.length);
  const last = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

export interface ApplyReport {
  readonly files: readonly ApplyFileReport[];
  readonly ok: boolean;
}

export interface ApplyFileReport {
  readonly path: string;
  readonly status: "applied" | "skipped" | "failed" | "unchanged";
  readonly hunksApplied: number;
  readonly hunksFailed: number;
  readonly note?: string;
}

export interface ApplyOptions {
  /** Write changes to disk. When false, only report what would happen. */
  readonly write?: boolean;
  /** Log per-file progress. */
  readonly logger?: (message: string) => void;
  /** Map a sandbox path to the real path, when the trees differ in layout. */
  readonly pathMap?: (sandboxPath: string) => string;
}

/**
 * Maps sandbox paths back to real paths, then applies the diff.
 *
 * Guard: a restored path that escapes the real root is rejected. The cloud model
 * cannot write outside the tree even if it emits `../../` in a diff header.
 */
export async function applyDiff(
  diff: ParsedDiff,
  realRoot: string,
  vault: Vault,
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  const log = options.logger ?? (() => {});
  const write = options.write ?? true;
  const root = resolve(realRoot);
  const reports: ApplyFileReport[] = [];

  for (const file of diff.files) {
    const mapped = options.pathMap ? options.pathMap(file.path) : file.path;
    const restored = vault.restore(mapped);
    const target = resolve(root, restored);

    const insideRoot = target === root || target.startsWith(root + "\\") || target.startsWith(root + "/");
    if (!insideRoot) {
      reports.push({
        path: restored,
        status: "failed",
        hunksApplied: 0,
        hunksFailed: file.hunks.length,
        note: "path escapes the repository root; refusing",
      });
      log(`  BLOCK ${restored} (escapes root)`);
      continue;
    }

    if (file.status === "deleted") {
      if (write) {
        const { rm } = await import("node:fs/promises");
        await rm(target, { force: true });
      }
      reports.push({ path: restored, status: "applied", hunksApplied: 0, hunksFailed: 0, note: "deleted" });
      log(`  rm    ${restored}`);
      continue;
    }

    // Restore hunk content, then the +/- marker is applied on the real text.
    const restoredHunks = file.hunks.map((h) => vault.restore(h));

    if (file.status === "added") {
      if (write) {
        await mkdir(dirname(target), { recursive: true });
        const content = restoredHunks.join("\n");
        await writeFile(target, content.endsWith("\n") ? content : content + "\n", "utf8");
      }
      reports.push({
        path: restored,
        status: "applied",
        hunksApplied: 1,
        hunksFailed: 0,
        note: "new file",
      });
      log(`  add   ${restored}`);
      continue;
    }

    let originalText: string;
    try {
      originalText = await readFile(target, "utf8");
    } catch {
      reports.push({
        path: restored,
        status: "failed",
        hunksApplied: 0,
        hunksFailed: file.hunks.length,
        note: "target file does not exist in the real repository",
      });
      log(`  FAIL  ${restored} (missing)`);
      continue;
    }

    const eol = originalText.includes("\r\n") ? "\r\n" : "\n";
    const originalLines = originalText.split(/\r?\n/);
    const result = applyHunks(originalLines, restoredHunks);

    if (result.applied === 0 && result.failed > 0) {
      reports.push({
        path: restored,
        status: "failed",
        hunksApplied: 0,
        hunksFailed: result.failed,
        note: "no hunk matched; needs reconciliation",
      });
      log(`  FAIL  ${restored} (${result.failed} hunks)`);
      continue;
    }

    if (result.failed > 0) {
      log(`  WARN  ${restored} (${result.failed}/${result.applied + result.failed} hunks)`);
    } else {
      log(`  ok    ${restored}`);
    }

    if (write && result.applied > 0) {
      await writeFile(target, result.lines.join(eol), "utf8");
    }

    reports.push({
      path: restored,
      status: result.failed > 0 ? "skipped" : "applied",
      hunksApplied: result.applied,
      hunksFailed: result.failed,
      ...(result.failed > 0 ? { note: `${result.failed} hunk(s) need reconciliation` } : {}),
    });
  }

  const ok = reports.every((r) => r.status !== "failed");
  return { files: reports, ok };
}

/**
 * Runs git in `cwd` and returns stdout. Used to produce and consume the diff.
 * Never throws on a non-zero exit; callers inspect the status.
 */
export function git(cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", [...args], { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => resolvePromise({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    setTimeout(() => child.kill(), timeoutMs);
  });
}

/**
 * Commits the freshly built sandbox as a git baseline.
 *
 * This MUST run before the cloud model starts. Diffing against a committed
 * baseline is what lets us recover exactly what layer 2 changed, including
 * files it created, without depending on the sandbox's history.
 */
export async function initSandboxBaseline(sandboxRoot: string): Promise<{ ok: boolean; error?: string }> {
  const init = await git(sandboxRoot, ["init", "-q"]);
  if (init.code !== 0) return { ok: false, error: init.stderr.trim() || "git init failed" };
  await git(sandboxRoot, ["config", "user.email", "mentat@localhost"]);
  await git(sandboxRoot, ["config", "user.name", "Mentat"]);
  await git(sandboxRoot, ["config", "commit.gpgsign", "false"]);
  await git(sandboxRoot, ["add", "-A", "-f"]);
  const commit = await git(sandboxRoot, ["commit", "-q", "--no-verify", "-m", "mentat: synthetic baseline"]);
  if (commit.code !== 0) return { ok: false, error: commit.stderr.trim() || "baseline commit failed" };
  return { ok: true };
}

/**
 * Produces the model's work as a diff against the baseline commit. Captures
 * modifications, additions, deletions, and renames in one pass.
 */
export async function collectSandboxDiff(sandboxRoot: string): Promise<string> {
  await git(sandboxRoot, ["add", "-A", "-f"]);
  const diff = await git(sandboxRoot, [
    "diff",
    "--cached",
    "--no-color",
    "--unified=3",
    "--no-ext-diff",
    "--find-renames",
  ]);
  if (diff.code !== 0 && diff.stdout.trim() === "") return "";
  return diff.stdout;
}

export { join, mkdir as mkdirAsync };