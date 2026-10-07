import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { IdentifierVault } from "../src/vault.js"
import {
  skeletonizeFile,
  collectIdentifierTokens,
  rankFiles,
  redactNetworkLiterals,
} from "../src/skeleton.js"

const here = dirname(fileURLToPath(import.meta.url))
const billingTs = readFileSync(join(here, "fixtures", "repo", "billing.ts"), "utf8")
const churnPy = readFileSync(join(here, "fixtures", "repo", "churn.py"), "utf8")

describe("skeletonizeFile", () => {
  it("renames proprietary identifiers but keeps language keywords", () => {
    const reserved = new Set<string>()
    for (const token of collectIdentifierTokens(billingTs)) reserved.add(token)
    const vault = new IdentifierVault("skel-seed", reserved)
    const skeleton = skeletonizeFile("src/billing.ts", billingTs, vault, {
      strings: "redact-secrets",
      comments: "keep",
      maxLines: 400,
    })
    assert.ok(!skeleton.content.includes("AcmeLedgerClient"), "real identifier leaked")
    assert.ok(!skeleton.content.includes("settleAcmeInvoice"), "real identifier leaked")
    assert.ok(skeleton.content.includes("import"), "keyword lost")
    assert.ok(skeleton.content.includes("export"), "keyword lost")
    assert.ok(skeleton.content.includes("async"), "keyword lost")
    assert.ok(skeleton.renamed > 5)
  })

  it("maps paths deterministically and keeps extensions", () => {
    const vault = new IdentifierVault("skel-seed")
    const first = skeletonizeFile("src/billing.ts", billingTs, vault, {
      strings: "keep",
      comments: "keep",
      maxLines: 400,
    })
    const second = skeletonizeFile("src/billing.ts", billingTs, new IdentifierVault("skel-seed"), {
      strings: "keep",
      comments: "keep",
      maxLines: 400,
    })
    assert.equal(first.mockPath, second.mockPath)
    assert.ok(first.mockPath.endsWith(".ts"))
    assert.ok(!first.mockPath.includes("billing"))
  })

  it("redacts secret-shaped strings, keeps ordinary strings", () => {
    const vault = new IdentifierVault("skel-seed")
    const skeleton = skeletonizeFile("src/billing.ts", billingTs, vault, {
      strings: "redact-secrets",
      comments: "keep",
      maxLines: 400,
    })
    assert.ok(!skeleton.content.includes("sk-test-4f8a2b9c0d1e6f7a8b9c0d1e6f7a8b9c"), "fake API key survived")
    // 1 secret redaction + 1 URL-host apex reduction.
    assert.equal(skeleton.redactedStrings, 2)
    assert.ok(skeleton.content.includes("https://example.com/v2"), "URL host not normalized")
    assert.ok(skeleton.content.includes("Refusing to settle invoice"), "ordinary string lost")
  })

  it("keeps python structure (def/import) while renaming", () => {
    const reserved = new Set<string>()
    for (const token of collectIdentifierTokens(churnPy)) reserved.add(token)
    const vault = new IdentifierVault("skel-seed", reserved)
    const skeleton = skeletonizeFile("ml/churn.py", churnPy, vault, {
      strings: "keep",
      comments: "keep",
      maxLines: 400,
    })
    assert.ok(skeleton.content.includes("def "), "def lost")
    assert.ok(skeleton.content.includes("import "), "import lost")
    assert.ok(!skeleton.content.includes("ACME_CHURN_THRESHOLD"), "real constant leaked")
  })

  it("truncates long files with an elision marker", () => {
    const vault = new IdentifierVault("skel-seed")
    const long = Array.from({ length: 100 }, (_, i) => `const value${i} = ${i}`).join("\n")
    const skeleton = skeletonizeFile("big.ts", long, vault, { strings: "keep", comments: "keep", maxLines: 20 })
    assert.ok(skeleton.content.includes("elided by Mentat"))
    assert.equal(skeleton.truncatedLines, 80)
  })
})

describe("rankFiles", () => {
  it("ranks keyword-relevant files first, deterministically", () => {
    const files = [
      { path: "src/billing.ts", content: billingTs },
      { path: "ml/churn.py", content: churnPy },
    ]
    const ranked = rankFiles(files, ["churn", "customers", "risk"])
    assert.equal(ranked[0]?.path, "ml/churn.py")
    const again = rankFiles(files, ["churn", "customers", "risk"])
    assert.deepEqual(
      ranked.map((file) => file.path),
      again.map((file) => file.path),
    )
  })
})
