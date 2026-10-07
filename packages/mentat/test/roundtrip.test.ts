import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { prepareBundle } from "../src/bundle.js"
import { reintegrateCloudOutput } from "../src/reintegrate.js"
import { scanForLeaks } from "../src/scanner.js"
import { DEFAULT_CONFIG } from "../src/config.js"
import { MentatLeakError } from "../src/audit.js"

const here = dirname(fileURLToPath(import.meta.url))
const billingTs = readFileSync(join(here, "fixtures", "repo", "billing.ts"), "utf8")
const churnPy = readFileSync(join(here, "fixtures", "repo", "churn.py"), "utf8")
const customersCsv = readFileSync(join(here, "fixtures", "data", "customers.csv"), "utf8")

const SEED = "roundtrip-seed"

describe("prepareBundle (Layer 1 gatekeeper)", () => {
  it("builds a mock bundle with no real identifiers in the egress bytes", () => {
    const { bundle, markdown, vault } = prepareBundle({
      task: "Fix settleAcmeInvoice so zero-total invoices in billing.ts are rejected with a clear error.",
      files: [
        { path: "src/billing.ts", content: billingTs },
        { path: "ml/churn.py", content: churnPy },
      ],
      datasets: [{ name: "customers.csv", csvText: customersCsv }],
      entities: ["AcmeCorp"],
      seed: SEED,
    })

    assert.equal(bundle.files.length, 2)
    assert.equal(bundle.datasets.length, 1)
    // The task mentioned real names; they must have been rewritten to mocks.
    assert.ok(!markdown.includes("settleAcmeInvoice"))
    assert.ok(!markdown.includes("AcmeCorp"))
    assert.ok(!markdown.includes("billing.ts"))
    assert.ok(!markdown.includes("sk-test-4f8a2b9c0d1e6f7a8b9c0d1e6f7a8b9c"))
    assert.ok(!markdown.includes("alice@example.org"))
    // Structure survives.
    assert.ok(markdown.includes("async"))
    assert.ok(markdown.includes("```csv"))

    // Independent re-scan of the exact egress bytes: must be clean.
    const verdict = scanForLeaks(markdown, vault.secrets(DEFAULT_CONFIG.minSecretLength), {
      minSecretLength: DEFAULT_CONFIG.minSecretLength,
    })
    assert.equal(verdict.clean, true)
  })

  it("fails closed when the task carries a secret-shaped value", () => {
    assert.throws(
      () =>
        prepareBundle({
          task: "Debug with this key AKIAIOSFODNN7EXAMPLE urgently",
          files: [{ path: "src/billing.ts", content: billingTs }],
          datasets: [],
          seed: SEED,
        }),
      MentatLeakError,
    )
  })

  it("is deterministic for the same seed", () => {
    const input = {
      task: "Refactor the churn helpers.",
      files: [{ path: "ml/churn.py", content: churnPy }],
      datasets: [{ name: "customers.csv", csvText: customersCsv }],
      seed: SEED,
    }
    const first = prepareBundle(input)
    const second = prepareBundle(input)
    assert.equal(first.markdown, second.markdown)
    assert.equal(first.egressSha256, second.egressSha256)
  })
})

describe("reintegrateCloudOutput (Layer 1 unpacker)", () => {
  it("maps a mock-space diff back to real identifiers", () => {
    const { vault } = prepareBundle({
      task: "Fix the settlement validation.",
      files: [{ path: "src/billing.ts", content: billingTs }],
      datasets: [],
      seed: SEED,
    })
    const mockFn = vault.mockFor("settleAcmeInvoice") as string
    const mockClient = vault.mockFor("AcmeLedgerClient") as string
    const mockPath = `${vault.mockFor("src") as string}/${vault.mockFor("billing") as string}.ts`

    const cloudOutput = [
      "Notes:",
      "1. Reject non-positive totals before charging.",
      "",
      "```diff",
      `--- a/${mockPath}`,
      `+++ b/${mockPath}`,
      "@@ -1,3 +1,5 @@",
      `-export async function ${mockFn}(client: ${mockClient}, invoice) {`,
      `+export async function ${mockFn}(client: ${mockClient}, invoice) {`,
      "+  if (invoice.totalCents <= 0) throw new Error('bad total')",
      "```",
    ].join("\n")

    const report = reintegrateCloudOutput(cloudOutput, vault)
    assert.ok(report.realText.includes("settleAcmeInvoice"))
    assert.ok(report.realText.includes("AcmeLedgerClient"))
    assert.ok(report.realText.includes("src/billing.ts"))
    assert.ok(!report.realText.includes(mockFn))
    assert.equal(report.leftoverMocks.length, 0)
    assert.ok(report.mapped >= 3)
  })

  it("flags hallucinated mock-looking tokens from the cloud", () => {
    const { vault } = prepareBundle({
      task: "Fix it.",
      files: [{ path: "src/billing.ts", content: billingTs }],
      datasets: [],
      seed: SEED,
    })
    const report = reintegrateCloudOutput("Also update zebra_quarry to match.", vault)
    assert.ok(report.unmappedMocks.includes("zebra_quarry"))
  })
})
