import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Vault, TOKEN_PREFIX } from "../src/vault/Vault.js";
import { sanitizeSource } from "../src/redact/source.js";
import { scan } from "../src/scan/scan.js";

describe("comment tokenization", () => {
  it("tokenizes an identifier that appears only in a comment", () => {
    // Regression: comments used to receive only dictionary scrubbing, so a
    // proprietary name that never appeared in code position was never added to
    // the vault and survived verbatim into the mirror.
    const vault = new Vault();
    const src = "# Uses burgfeldt under the hood\ndef handle():\n    return 1\n";
    const out = sanitizeSource(src, "python", vault);
    assert.ok(!out.text.includes("burgfeldt"), `comment-only identifier survived: ${out.text}`);
    assert.ok(out.text.includes(TOKEN_PREFIX), `expected a token, got: ${out.text}`);
    assert.ok(vault.has("burgfeldt"), "the identifier must enter the vault");
  });

  it("restores a comment-tokenized identifier exactly", () => {
    const vault = new Vault();
    const src = "# Refactor the burgfeldt ingestion pipeline\ndef handle():\n    return 1\n";
    const out = sanitizeSource(src, "python", vault);
    assert.equal(vault.restore(out.text), src, "tokenize + restore must be a round trip");
  });

  it("leaves ordinary comment prose readable", () => {
    // The generic-vocabulary guards must survive the new pass: an over-scrubbed
    // comment is worse than a slightly leaky one for the cloud model's work.
    const vault = new Vault();
    const src = "# Compute the total count and return it\ndef handle():\n    return 1\n";
    const out = sanitizeSource(src, "python", vault);
    assert.equal(out.text, src, `innocent prose was mangled: ${out.text}`);
  });

  it("replaces already-known vault entries in comments", () => {
    const vault = new Vault();
    vault.tokenize("acmebilling", "org", "text");
    const out = sanitizeSource("# Talks to acmebilling daily\ndef handle(): pass\n", "python", vault);
    assert.ok(!out.text.includes("acmebilling"));
  });

  it("does not tokenize bare identifiers inside string literals", () => {
    // String values may be runtime data (lookup keys, config values); changing
    // them would change the mock's behaviour. Strings are scrubbed for known
    // secrets, not tokenized. This test pins that boundary.
    const vault = new Vault();
    const out = sanitizeSource('KEY = "burgfeldt"\n', "python", vault);
    assert.ok(out.text.includes('"burgfeldt"'), `string literal was rewritten: ${out.text}`);
  });

  it("produces a payload that passes its own vault-literal scan", () => {
    const vault = new Vault();
    const src = [
      "# Pipeline maintained by burgfeldt",
      "def compute_rows(rows):",
      '    """Rows for the ledger."""',
      "    return len(rows)",
      "",
    ].join("\n");
    const out = sanitizeSource(src, "python", vault);
    const report = scan(out.text, vault, { redact: true });
    assert.equal(report.ok, true, `sanitized source tripped the scanner: ${JSON.stringify(report.findings)}`);
  });
});
