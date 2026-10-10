import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Vault, detectShape, isStopword } from "../src/vault/Vault.js";
import { sanitizeSource, segment, languageFor, scrubProse, isSensitiveColumn } from "../src/redact/source.js";

describe("Vault", () => {
  it("round-trips identifiers exactly", () => {
    const v = new Vault();
    const entry = v.tokenize("acme_billing_ledger", "tbl", "data");
    const mock = `SELECT * FROM ${entry.token} WHERE id = 1`;
    assert.equal(v.restore(mock), "SELECT * FROM acme_billing_ledger WHERE id = 1");
  });

  it("produces deterministic tokens for the same input", () => {
    const a = new Vault();
    const b = new Vault();
    assert.equal(a.tokenize("customer_orders", "tbl", "data").token, b.tokenize("customer_orders", "tbl", "data").token);
  });

  it("mints distinct tokens per kind and per entry", () => {
    const v = new Vault();
    const t1 = v.tokenize("alpha_table", "tbl", "data").token;
    const t2 = v.tokenize("beta_table", "tbl", "data").token;
    const f1 = v.tokenize("gamma_fn", "fn", "code").token;
    assert.notEqual(t1, t2);
    assert.notEqual(t1, f1);
    assert.ok(t1.startsWith("zq_tbl_"));
    assert.ok(f1.startsWith("zq_fn_"));
  });

  it("does not mint tokens for reserved words or short names", () => {
    const v = new Vault();
    const src = "const config = parseConfig(input); if (config) return config;";
    sanitizeSource(src, "typescript", v);
    assert.equal(v.size, 0, `expected no tokens, got ${JSON.stringify(v.entries())}`);
  });

  it("detects identifier shapes", () => {
    assert.equal(detectShape("user_name"), "snake");
    assert.equal(detectShape("user-name"), "kebab");
    assert.equal(detectShape("UserName"), "pascal");
    assert.equal(detectShape("userName"), "camel");
    assert.equal(detectShape("MAX_RETRIES"), "upper");
  });

  it("treats common vocabulary as non-proprietary", () => {
    assert.ok(isStopword("config"));
    assert.ok(isStopword("handler"));
    assert.ok(!isStopword("acme_billing"));
  });

  it("sanitize and restore are inverses for multi-token text", () => {
    const v = new Vault();
    const a = v.tokenize("internal_risk_engine", "mod", "code").token;
    const b = v.tokenize("riskScore", "fn", "code").token;
    const mock = `import { ${b} } from "${a}"; // ${b} lives in ${a}`;
    const real = v.restore(mock);
    assert.ok(real.includes("internal_risk_engine"));
    assert.ok(real.includes("riskScore"));
    assert.equal(v.sanitize(real), mock);
  });
});

describe("string and comment sanitization", () => {
  it("replaces secrets inside string literals", () => {
    const v = new Vault();
    const { text } = sanitizeSource(
      'HOST = "10.4.2.19"\nOWNER = "alice@acmecorp.com"\nURL = "https://acmecorp.com/x"',
      "python",
      v,
    );
    assert.ok(!text.includes("10.4.2.19"), text);
    assert.ok(!text.includes("acmecorp.com"), text);
    assert.match(text, /192\.0\.2\./);
    assert.match(text, /user@example\.com/);
    assert.match(text, /example\.invalid/);
  });

  it("replaces proprietary terms inside docstrings and comments", () => {
    const v = new Vault();
    const { text } = sanitizeSource(
      [
        '"""AcmeCorp billing service.',
        "",
        "Handles the acme_billing_ledger for the platform.",
        '"""',
        "# deploy to 10.0.0.5",
        "def compute_acme_churn(rows):",
        "    return len(rows)",
      ].join("\n"),
      "python",
      v,
    );
    assert.ok(!text.includes("AcmeCorp"), text);
    assert.ok(!text.includes("acme_billing_ledger"), text);
    assert.ok(!text.includes("10.0.0.5"), text);
  });

  it("never tokenizes a standard library import", () => {
    const v = new Vault();
    const { text } = sanitizeSource(
      "from dataclasses import dataclass\nimport pandas as pd\n\n@dataclass\nclass AcmeThing:\n    pass",
      "python",
      v,
    );
    assert.match(text, /from dataclasses import dataclass/);
    assert.match(text, /^import pandas as pd$/m);
    assert.match(text, /@dataclass/);
  });

  it("never tokenizes a third-party API reached through an alias", () => {
    const v = new Vault();
    const { text } = sanitizeSource(
      "import pandas as pd\n\ndef load_acme_ledger(path):\n    return pd.read_parquet(path)",
      "python",
      v,
    );
    assert.match(text, /pd\.read_parquet/);
    // The user's own function is still tokenized.
    assert.match(text, /def zq_fn_\w+\(path\)/);
  });

  it("never tokenizes language keywords and literals", () => {
    const v = new Vault();
    const { text } = sanitizeSource(
      "def test_it():\n    assert True\n    x = None\n    return False if x else True",
      "python",
      v,
    );
    assert.match(text, /assert True/);
    assert.match(text, /x = None/);
    assert.match(text, /return False if x else True/);
  });

  it("scrubs prose files wholesale", async () => {
    const v = new Vault();
    const { text } = scrubProse(
      "# AcmeCorp\nOwner: alice@acmecorp.com\nSee acme_billing_ledger for details.",
      v,
    );
    assert.ok(!/acme/i.test(text), text);
    assert.ok(!text.includes("@acmecorp.com"), text);
  });
});

describe("isSensitiveColumn", () => {
  it("matches by containment, not just equality", () => {
    assert.ok(isSensitiveColumn("customer_email", ["email"]));
    assert.ok(isSensitiveColumn("billing_email_address", ["email"]));
    assert.ok(isSensitiveColumn("EMAIL", ["email"]));
    assert.ok(isSensitiveColumn("anything", ["*"]));
  });

  it("does not match unrelated columns", () => {
    assert.ok(!isSensitiveColumn("tenure_months", ["email", "name"]));
    assert.ok(!isSensitiveColumn("region", ["email"]));
  });
});

describe("vault integrity", () => {
  it("never re-tokenizes a token", () => {
    const v = new Vault();
    const first = v.tokenize("acme_billing", "mod", "code").token;
    // Feeding sanitized text back through the redactor must be a no-op.
    const { text } = sanitizeSource(`def f():\n    """Uses ${first} heavily."""`, "python", v);
    assert.equal(text, `def f():\n    """Uses ${first} heavily."""`);
    for (const e of v.entries()) {
      assert.ok(!e.real.startsWith("zq_"), `vault entry maps a token: ${e.token} -> ${e.real}`);
    }
  });

  it("does not replace a short name inside a longer identifier", () => {
    const v = new Vault();
    v.tokenize("acme_billing", "mod", "code");
    const longer = "acme_billing_ledger";
    // `acme_billing` is a prefix of `acme_billing_ledger`; substituting it would
    // produce `zq_mod_mod_001_ledger` and corrupt the longer name.
    const out = v.sanitize(`SELECT * FROM ${longer}`);
    assert.ok(!out.includes("zq_mod_mod_001_ledger"), out);
    assert.equal(v.restore(out), `SELECT * FROM ${longer}`);
  });

  it("round-trips a prefix-sharing pair independently", () => {
    const v = new Vault();
    const a = v.tokenize("acme_billing", "mod", "code").token;
    const b = v.tokenize("acme_billing_ledger", "tbl", "data").token;
    const original = "acme_billing_ledger and acme_billing";
    const mocked = v.sanitize(original);
    assert.ok(mocked.includes(b));
    assert.ok(!mocked.includes("zq_") || mocked.split("zq_").length > 2);
    assert.equal(v.restore(mocked), original);
    assert.notEqual(a, b);
  });

  it("stays consistent after sanitizing many times", () => {
    const v = new Vault();
    const terms = ["AcmeCorp", "acme_billing", "acme_billing_ledger", "acme_customer_orders"];
    for (const t of terms) v.tokenize(t, "org", "text");
    let text = "AcmeCorp owns acme_billing_ledger which reads acme_customer_orders in acme_billing";
    const first = v.sanitize(text);
    // Repeated sanitization must converge, not drift.
    for (let i = 0; i < 5; i++) {
      assert.equal(v.sanitize(first), first, "sanitize is not idempotent");
    }
    assert.equal(v.restore(first), text);
  });
});

describe("segment", () => {
  it("keeps strings and comments out of code segments", () => {
    const src = 'const secretToken = "acme-secret" // acme_billing\n/* acme_ledger */\nconst x = 1';
    const segs = segment(src, "typescript");
    const code = segs.filter((s) => s.kind === "code").map((s) => s.text).join("");
    assert.ok(!code.includes("acme-secret"));
    assert.ok(!code.includes("acme_billing"));
    assert.ok(!code.includes("acme_ledger"));
    // Reconstruction must be lossless.
    assert.equal(segs.map((s) => s.text).join(""), src);
  });

  it("handles python triple quotes and hashes", () => {
    const src = 'x = """doc acme_ledger"""\n# comment acme_billing\ny = 2';
    const segs = segment(src, "python");
    assert.equal(segs.map((s) => s.text).join(""), src);
    const code = segs.filter((s) => s.kind === "code").map((s) => s.text).join("");
    assert.ok(!code.includes("acme_ledger"));
  });

  it("does not treat a hash inside a string as a comment", () => {
    const src = 'url = "http://host/#frag"\nx = 1';
    const segs = segment(src, "python");
    assert.equal(segs.map((s) => s.text).join(""), src);
    assert.equal(segs.find((s) => s.kind === "string")?.text, '"http://host/#frag"');
  });
});

describe("sanitizeSource", () => {
  it("preserves structure exactly", () => {
    const src = [
      "#!/usr/bin/env python3",
      "import pandas as pd",
      "",
      "def compute_acme_churn(rows):",
      "    # recompute the acme_ledger totals",
      "    total = sum(r.amount for r in rows)",
      "    return total / len(rows)",
      "",
    ].join("\n");
    const v = new Vault();
    const { text } = sanitizeSource(src, "python", v);
    assert.equal(text.split("\n").length, src.split("\n").length, "line count must be preserved");
    assert.ok(text.includes("import pandas as pd"));
    assert.ok(text.includes("def "));
    assert.ok(v.size > 0);
  });

  it("tokenizes table names in SQL", () => {
    const v = new Vault();
    const { text } = sanitizeSource(
      "SELECT customer_id FROM acme_customer_orders WHERE region = 'emea';",
      "sql",
      v,
      { tokenizeStrings: false },
    );
    assert.ok(text.includes("zq_"), `expected a token in: ${text}`);
    assert.ok(!text.includes("acme_customer_orders"));
  });

  it("maps extensions to languages", () => {
    assert.equal(languageFor("a/b/c.ts"), "typescript");
    assert.equal(languageFor("q.py"), "python");
    assert.equal(languageFor("schema.sql"), "sql");
    assert.equal(languageFor("notes.md"), "markdown");
    assert.equal(languageFor("blob.bin"), "text");
  });
});