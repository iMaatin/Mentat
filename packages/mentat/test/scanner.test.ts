import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { scanForLeaks } from "../src/scanner.js"

describe("scanForLeaks", () => {
  it("passes clean mock text", () => {
    const verdict = scanForLeaks(
      "Fix the bright_ledger module so settle works when total is zero.",
      ["AcmeLedgerClient", "settleAcmeInvoice"],
    )
    assert.equal(verdict.clean, true)
    assert.equal(verdict.findings.length, 0)
  })

  it("catches vault secrets with word boundaries", () => {
    const verdict = scanForLeaks("Call settleAcmeInvoice here.", ["settleAcmeInvoice"])
    assert.equal(verdict.clean, false)
    assert.equal(verdict.findings[0]?.rule, "secret:vault")
  })

  it("does not flag substrings inside larger words", () => {
    const verdict = scanForLeaks("The classic invoice flow works.", ["class"])
    assert.equal(verdict.clean, true)
  })

  it("skips secrets shorter than minSecretLength", () => {
    const verdict = scanForLeaks("Use id here.", ["id"], { minSecretLength: 4 })
    assert.equal(verdict.clean, true)
  })

  it("catches substring secrets with special characters (no boundaries)", () => {
    const verdict = scanForLeaks("endpoint=https://billing.acme-internal.example.com/v2;", [
      "https://billing.acme-internal.example.com/v2",
    ])
    assert.equal(verdict.clean, false)
  })

  it("catches built-in secret patterns (aws key, private key, api assignment)", () => {
    const aws = scanForLeaks("key = AKIAIOSFODNN7EXAMPLE", [])
    assert.equal(aws.clean, false)
    assert.equal(aws.findings[0]?.rule, "pattern:aws-access-key")

    const pem = scanForLeaks("-----BEGIN RSA PRIVATE KEY-----\nabc", [])
    assert.equal(pem.clean, false)

    const assign = scanForLeaks('api_key = "super-secret-value-123"', [])
    assert.equal(assign.clean, false)
  })

  it("catches high-entropy tokens", () => {
    const verdict = scanForLeaks("token GH7kd92LpQe5Rt8Yw1Zx4Cv6Bn0M issued", [])
    assert.equal(verdict.clean, false)
    assert.ok(verdict.findings.some((finding) => finding.rule === "pattern:high-entropy-token"))
  })

  it("exempts Mentat-generated documentation hosts (fixed strings, no user data)", () => {
    const verdict = scanForLeaks("fetch https://example.com/v2/items then parse", ["example"])
    assert.equal(verdict.clean, true)
  })

  it("still scans URL paths and non-conforming hosts", () => {
    const pathHit = scanForLeaks("fetch https://example.com/AcmeLedger/v2", ["AcmeLedger"])
    assert.equal(pathHit.clean, false)
    const hostHit = scanForLeaks("fetch https://acme-internal.corp/v2", ["acme-internal"])
    assert.equal(hostHit.clean, false)
  })

  it("redacts excerpts so findings never carry the secret", () => {
    const secret = "AcmeLedgerClientSecretValue"
    const verdict = scanForLeaks(`leak: ${secret} end`, [secret])
    assert.equal(verdict.clean, false)
    assert.ok(!verdict.findings[0]?.excerpt.includes(secret))
    assert.ok(verdict.findings[0]?.excerpt.includes("***"))
  })
})
