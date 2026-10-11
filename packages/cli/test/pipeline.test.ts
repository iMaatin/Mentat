import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobPaths, loadReport } from "@mentat/core";
import { DEFAULT_CONFIG, type MentatConfig } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";

/**
 * Stage-3 regression: the outbound task must be run through `vault.sanitize`
 * before the egress scan. The local rewriter has no vault, so any real
 * identifier it echoes would survive into the prompt and trip the gate — the
 * reported "vault-literal x3 (critical)" failure. This test proves a known
 * vault literal in the request is tokenized and produces no vault-literal
 * finding.
 *
 * The request also carries a structural AWS key, which `vault.sanitize`
 * deliberately cannot rewrite (a credential is not an identifier). That keeps
 * the run blocked at the preview — so `delegate` is never reached and the test
 * spawns no cloud process — while still letting us assert the vault literal is
 * gone and only the structural finding remains.
 */
describe("pipeline stage 3 — outbound sanitize", () => {
  let projectRoot: string;
  let jobsRoot: string;
  let sandboxBase: string;

  const config: MentatConfig = { ...DEFAULT_CONFIG, verbose: false };

  before(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mentat-cli-repo-"));
    jobsRoot = join(projectRoot, ".mentat", "jobs");
    sandboxBase = await mkdtemp(join(tmpdir(), "mentat-cli-sandbox-"));
    await mkdir(join(projectRoot, "src"), { recursive: true });
    // A module-level name that is not made of generic words, so the sandbox
    // build tokenizes it into the vault (same treatment as sandbox.test.ts).
    await writeFile(
      join(projectRoot, "src", "billing.py"),
      ["acme_billing_ledger = []", "", "def compute_churn(rows):", "    return len(rows)", ""].join("\n"),
      "utf8",
    );
  });

  after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(sandboxBase, { recursive: true, force: true });
  });

  it("tokenizes a known vault literal in the request before the egress scan", async () => {
    let reviewed: string[] = [];
    const outcome = await runPipeline({
      projectRoot,
      jobsRoot,
      sandboxBase,
      // A known real (tokenized from src/billing.py) plus a structural secret
      // that sanitize cannot remove. Decline the review so we never delegate.
      prompt: "Please refactor acme_billing_ledger; the live key is AKIAIOSFODNN7EXAMPLE.",
      config,
      skipLocalModel: true,
      reviewEgress: async (report) => {
        reviewed = report.findings.map((f) => f.rule);
        return false;
      },
    });

    // The run is blocked — but on the structural key, never on the vault
    // literal, which the stage-3 sanitize has already replaced.
    assert.ok(outcome.blocked, "the structural key must still block the run");
    assert.ok(reviewed.includes("aws-access-key"), "the AWS key finding is surfaced");
    assert.ok(
      !reviewed.includes("vault-literal"),
      "the tokenized identifier must not appear as a vault-literal finding",
    );

    // The bytes about to leave the machine carry the token, not the real name.
    const paths = jobPaths(jobsRoot, outcome.jobId);
    const sanitized = await readFile(paths.promptSanitized, "utf8");
    assert.ok(sanitized.includes("zq_"), "the real identifier is replaced by a token");
    assert.ok(
      !sanitized.includes("acme_billing_ledger"),
      "no vault literal survives into the outbound payload",
    );

    // The original request is kept verbatim so the two can be diffed later.
    const original = await readFile(paths.prompt, "utf8");
    assert.ok(original.includes("acme_billing_ledger"), "prompt.txt keeps the original request");

    const report = await loadReport(paths);
    assert.equal(report?.status, "failed");
    assert.equal(report?.egressApproved, undefined, "a declined review is not an approval");
  });
});
