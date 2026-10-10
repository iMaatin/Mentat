import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeJob,
  assertNotExfiltrated,
  BoundaryViolation,
  FORBIDDEN_OUTBOUND,
  newJobId,
  jobPaths,
} from "../src/job/job.js";

describe("removeJob containment", () => {
  it("removes a job inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mentat-jobroot-"));
    await mkdir(join(root, "20260101-000000-abc"), { recursive: true });
    await writeFile(join(root, "20260101-000000-abc", "vault.json"), "{}");
    await removeJob(root, "20260101-000000-abc");
    assert.equal(existsSync(join(root, "20260101-000000-abc")), false);
  });

  it("refuses an id that escapes into a sibling directory", async () => {
    // Regression: `startsWith(resolve(jobRoot))` passed for `…/jobs-evil`
    // because it begins with `…/jobs`, so `mentat clean ../jobs-evil` deleted
    // a directory outside the job root.
    const parent = await mkdtemp(join(tmpdir(), "mentat-jobsibling-"));
    const root = join(parent, "jobs");
    const sibling = join(parent, "jobs-evil");
    await mkdir(root, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "keep.txt"), "must survive");

    await assert.rejects(() => removeJob(root, "../jobs-evil"), /refusing to delete outside/);
    await assert.rejects(() => removeJob(root, ".."), /refusing to delete outside/);
    assert.equal(existsSync(join(sibling, "keep.txt")), true, "sibling directory was deleted");
  });

  it("refuses empty and self-referential ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "mentat-jobself-"));
    await assert.rejects(() => removeJob(root, ""), /refusing to delete outside/);
    await assert.rejects(() => removeJob(root, "."), /refusing to delete outside/);
    await assert.rejects(() => removeJob(root, "a/../.."), /refusing to delete outside/);
    assert.equal(existsSync(root), true, "the job root itself was deleted");
  });
});

describe("assertNotExfiltrated anchoring", () => {
  it("blocks Mentat artifact paths at a path boundary", () => {
    for (const bad of [
      "see .mentat/jobs/1",
      "the vault.json file",
      "prompt.txt contents",
      // A repo-relative path under a real sandbox/ directory is still refused:
      // fail closed when the path starts a segment.
      "fix sandbox/session.py",
      "C:\\proj\\sandbox\\a.py",
    ]) {
      assert.throws(() => assertNotExfiltrated(bad), BoundaryViolation, `should block: ${bad}`);
    }
  });

  it("allows substrings that merely contain a forbidden fragment", () => {
    // Regression: the raw substring "sandbox/" blocked every prompt that
    // mentioned a repository's own sandbox/ directory, and mid-word fragments
    // such as "mysandbox/" were blocked too.
    for (const good of [
      "refactor the loadsandbox/ helper",
      "my.sandbox/foo.py",
      "Add retry logic to the ingest pipeline.",
    ]) {
      assert.doesNotThrow(() => assertNotExfiltrated(good), `should allow: ${good}`);
    }
  });

  it("exposes the anchored rules for audit", () => {
    assert.ok(FORBIDDEN_OUTBOUND.length >= 4);
    for (const rule of FORBIDDEN_OUTBOUND) {
      assert.ok(rule instanceof RegExp);
    }
  });
});

describe("job ids", () => {
  it("are time-ordered and address the expected files", () => {
    const a = newJobId(new Date("2026-01-01T14:22:33"));
    assert.match(a, /^\d{8}-\d{6}-\w{3}$/);
    assert.ok(a.startsWith("20260101-142233-"));
    const paths = jobPaths("C:/jobs", a);
    assert.ok(paths.root.endsWith(a));
    assert.ok(paths.vault.endsWith("vault.json"));
  });
});
