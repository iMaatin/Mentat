import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Vault } from "../src/vault/Vault.js";
import { assertClean, scan, LeakDetected, formatReport } from "../src/scan/scan.js";

const vault = new Vault();

describe("scan", () => {
  it("passes a clean payload", () => {
    const report = scan("Add retry logic to the ingest pipeline.", vault);
    assert.equal(report.ok, true);
    assert.equal(report.findings.length, 0);
  });

  it("flags a real identifier that survived tokenization", () => {
    const v = new Vault();
    v.tokenize("acme_billing_ledger", "tbl", "data");
    const report = scan("Please update acme_billing_ledger tonight.", v);
    assert.equal(report.ok, false);
    assert.equal(report.findings[0]?.rule, "vault-literal");
    assert.equal(report.findings[0]?.severity, "critical");
  });

  it("flags AWS keys, private keys, and JWTs", () => {
    // Each payload must be blocked at high severity or above.
    for (const p of [
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "sk-proj-abcdefghijklmnopqrstuvwxyz12",
    ]) {
      const report = scan(p, vault);
      assert.equal(report.ok, false, `should have blocked: ${p.slice(0, 24)}`);
      assert.ok(
        report.findings[0]?.severity === "critical" || report.findings[0]?.severity === "high",
        `unexpected severity for ${p.slice(0, 24)}: ${report.findings[0]?.severity}`,
      );
    }
  });

  it("does not mistake a long digit string for a card number", () => {
    // Process ids, timestamps, and versions must not trip the card rule.
    for (const noise of [
      "manifest 15952-1791648020322 files",
      "version 2024.11.0.1791648020322",
      "C:\\\\Users\\\\Matin\\\\AppData\\\\Local\\\\Temp\\\\mentat-sandbox-13648-1791647893913",
    ]) {
      const report = scan(noise, vault);
      const card = report.findings.find((f) => f.rule === "credit-card");
      assert.equal(card, undefined, `false positive on ${noise}`);
    }
  });

  it("still catches a genuine card number", () => {
    // 4111111111111111 is the standard Luhn-valid test number.
    const report = scan("card 4111 1111 1111 1111 on file", vault);
    assert.ok(report.findings.some((f) => f.rule === "credit-card"));
  });

  it("flags emails and connection strings", () => {
    assert.equal(scan("contact alice.smith@acmecorp.com", vault).ok, false);
    const cs = scan("postgres://admin:hunter2@db.internal:5432/main", vault);
    assert.equal(cs.ok, false);
    assert.ok(cs.findings.some((f) => f.rule === "connection-string-creds"));
  });

  it("flags private network addresses and internal hosts", () => {
    assert.equal(scan("connect to 10.4.2.9", vault).ok, false);
    assert.equal(scan("deploy to build-01.corp", vault).ok, false);
  });

  it("redacts excerpts by default", () => {
    const report = scan("key is sk-proj-abcdefghijklmnopqrstuvwx here", vault);
    const finding = report.findings[0];
    assert.ok(finding);
    assert.ok(!finding.excerpt.includes("abcdefghijklmnop"));
  });

  it("treats low-severity findings as acceptable", () => {
    // A 40-hex sha is low severity, so the gate permits it.
    const report = scan("commit " + "a".repeat(40), vault);
    assert.equal(report.ok, true);
    assert.ok(report.findings.length > 0);
  });

  it("does not flag ordinary prose as a phone number", () => {
    const text =
      "The function should return the value from the cache when the entry is present, " +
      "and it should fall back to the database when the cache misses.";
    const report = scan(text, vault);
    assert.equal(report.ok, true, formatReport(report));
  });

  it("runs the structural rules on text that could match them", () => {
    // The scanner pre-filters on punctuation and digits, so a bare letter must
    // not claim to have run the credential rules.
    assert.ok(scan("a", vault).rulesRun.length <= 2);
    const report = scan("Update handler at 10.0.0.1 in src/app.ts", vault);
    assert.ok(report.rulesRun.length > 8, `only ran ${report.rulesRun.length} rules`);
  });
});

describe("assertClean", () => {
  it("throws on a dirty payload and carries the report", () => {
    const v = new Vault();
    v.tokenize("acme_secret_tenant", "org", "text");
    try {
      assertClean("touch acme_secret_tenant", v);
      assert.fail("expected LeakDetected");
    } catch (err) {
      assert.ok(err instanceof LeakDetected);
      assert.equal(err.report.ok, false);
      assert.match(err.message, /Egress blocked/);
    }
  });

  it("returns the report when clean", () => {
    const report = assertClean("nothing sensitive here", vault);
    assert.equal(report.ok, true);
  });
});