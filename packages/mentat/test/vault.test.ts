import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { IdentifierVault } from "../src/vault.js"

describe("IdentifierVault", () => {
  it("maps deterministically: same seed + real => same mock", () => {
    const first = new IdentifierVault("seed-1")
    const second = new IdentifierVault("seed-1")
    assert.equal(first.getOrCreate("identifier", "AcmeLedgerClient"), second.getOrCreate("identifier", "AcmeLedgerClient"))
  })

  it("uses different mocks for different seeds", () => {
    const first = new IdentifierVault("seed-1")
    const second = new IdentifierVault("seed-2")
    assert.notEqual(first.getOrCreate("identifier", "AcmeLedgerClient"), second.getOrCreate("identifier", "AcmeLedgerClient"))
  })

  it("round-trips real <-> mock", () => {
    const vault = new IdentifierVault("seed-1")
    const mock = vault.getOrCreate("identifier", "settleAcmeInvoice")
    assert.equal(vault.realFor(mock), "settleAcmeInvoice")
    assert.equal(vault.mockFor("settleAcmeInvoice"), mock)
  })

  it("never emits a mock that collides with reserved real tokens", () => {
    const vault = new IdentifierVault("seed-1", ["bright_ledger"])
    for (let i = 0; i < 50; i++) {
      const mock = vault.getOrCreate("identifier", `RealThing${i}`)
      assert.notEqual(mock, "bright_ledger")
    }
  })

  it("never emits duplicate mocks", () => {
    const vault = new IdentifierVault("seed-1")
    const mocks = new Set<string>()
    for (let i = 0; i < 200; i++) {
      mocks.add(vault.getOrCreate("identifier", `Widget${i}Controller`))
    }
    assert.equal(mocks.size, 200)
  })

  it("preserves casing style (PascalCase / UPPER_SNAKE)", () => {
    const vault = new IdentifierVault("seed-1")
    const pascal = vault.getOrCreate("identifier", "AcmeInvoice")
    assert.match(pascal, /^[A-Z][a-z]+_[a-z]+/)
    const upper = vault.getOrCreate("identifier", "ACME_API_ENDPOINT")
    assert.match(upper, /^[A-Z]+_[A-Z]+/)
  })

  it("serializes and restores without changing mappings", () => {
    const vault = new IdentifierVault("seed-9")
    vault.getOrCreate("identifier", "alpha")
    vault.getOrCreate("column", "customer_id")
    const restored = IdentifierVault.fromJSON(vault.toJSON())
    assert.equal(restored.mockFor("alpha"), vault.mockFor("alpha"))
    assert.equal(restored.mockFor("customer_id"), vault.mockFor("customer_id"))
    assert.equal(restored.size, 2)
  })
})
