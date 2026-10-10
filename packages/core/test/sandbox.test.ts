import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault/Vault.js";
import { buildSandbox, isSecretFile, isSecretDirectory } from "../src/sandbox/build.js";
import { parseDiff, applyDiff, applyHunks, initSandboxBaseline, collectSandboxDiff, git } from "../src/patch/apply.js";
import { assertNotExfiltrated, BoundaryViolation } from "../src/job/job.js";
import { scan } from "../src/scan/scan.js";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mentat-repo-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });

  await writeFile(
    join(root, "src", "acme_billing.py"),
    [
      "def compute_acme_churn(rows):",
      '    """Compute churn for the acme_billing_ledger."""',
      "    active = [r for r in rows if r.status == 'active']",
      "    return len(active) / len(rows)",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "data", "acme_customers.csv"),
    "customer_id,customer_email,region,tenure_months\n1,alice@acme.com,emea,12\n2,bob@acme.com,apac,4\n",
    "utf8",
  );
  await writeFile(join(root, "node_modules", "junk.js"), "module.exports = 1", "utf8");
  await writeFile(
    join(root, "README.md"),
    "# AcmeCorp internal project\n# Owner: alice@acmecorp.com\n# Deploy: 10.4.2.19\n",
    "utf8",
  );
  return root;
}

describe("buildSandbox", () => {
  let repo: string;
  let sandbox: string;
  const vault = new Vault();

  before(async () => {
    repo = await makeRepo();
    sandbox = join(tmpdir(), `mentat-sandbox-${process.pid}-${Date.now()}`);
    await buildSandbox(vault, {
      realRoot: repo,
      sandboxRoot: sandbox,
      datasets: [
        {
          realPath: "data/acme_customers.csv",
          sandboxPath: "data/zq_tbl_tbl_001.csv",
          rows: [
            { customer_id: "customer_id_00001", customer_email: "user1@example.com", region: "emea", tenure_months: 11 },
          ],
          profile: "mock",
          sourceRows: 2,
        },
      ],
    });
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  });

  it("mirrors source files under a token name", async () => {
    const files = await readdir(join(sandbox, "src"));
    // The real filename `acme_billing.py` is itself proprietary, so the
    // sandbox must not contain it.
    assert.ok(!files.includes("acme_billing.py"), `leaked filename: ${files.join(", ")}`);
    const mirrored = files.find((f) => f.startsWith("zq_"));
    assert.ok(mirrored, `expected a tokenized filename, got ${files.join(", ")}`);
    const exists = await readFile(join(sandbox, "src", mirrored as string), "utf8");
    assert.match(exists, /def zq_fn_\w+/);
  });

  it("omits node_modules", async () => {
    await assert.rejects(() => readFile(join(sandbox, "node_modules", "junk.js"), "utf8"));
  });

  it("writes the mocked dataset under a token name, never the real rows", async () => {
    const files = await readdir(join(sandbox, "data"));
    assert.ok(!files.includes("acme_customers.csv"), `leaked dataset filename: ${files.join(", ")}`);
    const mirrored = files[0] as string;
    const csv = await readFile(join(sandbox, "data", mirrored), "utf8");
    assert.ok(!csv.includes("alice@acme.com"), "real email leaked into the sandbox");
    assert.ok(csv.includes("customer_id,customer_email,region,tenure_months"), "header must be preserved");
    assert.ok(csv.includes("user1@example.com"));
  });

  it("writes AGENTS.md telling the cloud model what the tokens are", async () => {
    const agents = await readFile(join(sandbox, "AGENTS.md"), "utf8");
    assert.match(agents, /zq_\*/);
    assert.match(agents, /Ground rules/);
  });

  it("contains no real identifier or PII anywhere, including filenames", async () => {
    const files: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), rel);
        else files.push(rel);
      }
    };
    await walk(sandbox, "");
    assert.ok(files.length > 3);
    for (const f of files) {
      const text = await readFile(join(sandbox, ...f.split("/")), "utf8");
      const report = scan(text, vault, { redact: false });
      // A clean sandbox must raise nothing at high severity or above.
      const bad = report.findings.filter((x) => x.severity === "critical" || x.severity === "high");
      assert.equal(bad.length, 0, `${f} contains ${JSON.stringify(bad)}`);
    }
  });

  it("contains no proprietary term in any path", async () => {
    const files: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), rel);
        else files.push(rel);
      }
    };
    await walk(sandbox, "");
    for (const f of files) {
      assert.ok(!/acme/i.test(f), `proprietary term in sandbox path: ${f}`);
    }
  });

  it("scrubs proprietary prose out of documentation", async () => {
    const files = await readdir(sandbox);
    const readme = files.find((f) => f.toLowerCase().startsWith("readme"));
    assert.ok(readme, "README was not mirrored");
    const text = await readFile(join(sandbox, readme as string), "utf8");
    assert.ok(!/acme/i.test(text), `README leaked a proprietary term: ${text}`);
  });

  it("refuses duplicate sandbox paths instead of silently overwriting", async () => {
    const repo2 = await mkdtemp(join(tmpdir(), "mentat-dup-"));
    await mkdir(join(repo2, "raw"), { recursive: true });
    await writeFile(join(repo2, "raw", "acme.db"), "x", "utf8");
    await writeFile(join(repo2, "raw", "acme.parquet"), "y", "utf8");
    const entry = (realPath: string) => ({
      realPath,
      sandboxPath: "raw/acme.csv",
      rows: [],
      profile: "p",
      sourceRows: 0,
    });
    await assert.rejects(
      () =>
        buildSandbox(new Vault(), {
          realRoot: repo2,
          sandboxRoot: join(tmpdir(), `mentat-dup-sb-${process.pid}-${Date.now()}`),
          datasets: [entry("raw/acme.db"), entry("raw/acme.parquet")],
        }),
      /Duplicate sandbox path/,
    );
    await rm(repo2, { recursive: true, force: true });
  });

  it("supports several mocked tables from one source file", async () => {
    const repo2 = await mkdtemp(join(tmpdir(), "mentat-multi-"));
    await mkdir(join(repo2, "raw"), { recursive: true });
    await writeFile(join(repo2, "raw", "warehouse.db"), "x", "utf8");
    const sandbox2 = join(tmpdir(), `mentat-multi-sb-${process.pid}-${Date.now()}`);
    const manifest = await buildSandbox(new Vault(), {
      realRoot: repo2,
      sandboxRoot: sandbox2,
      datasets: [
        {
          realPath: "raw/warehouse.db",
          sandboxPath: "raw/warehouse_zq_tbl_tbl_001.csv",
          rows: [{ a: 1 }],
          profile: "p",
          sourceRows: 10,
        },
        {
          realPath: "raw/warehouse.db",
          sandboxPath: "raw/warehouse_zq_tbl_tbl_002.csv",
          rows: [{ b: 2 }],
          profile: "p",
          sourceRows: 20,
        },
      ],
    });
    assert.equal(manifest.mockData.length, 2);
    await rm(repo2, { recursive: true, force: true });
    await rm(sandbox2, { recursive: true, force: true });
  });

  it("refuses to build inside the real repository", async () => {
    await assert.rejects(
      () => buildSandbox(new Vault(), { realRoot: repo, sandboxRoot: join(repo, "inner") }),
      /Refusing to build the sandbox inside/,
    );
  });
});

describe("patch round trip", () => {
  it("parses a unified diff into files and hunks", () => {
    const raw = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 111..222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+line2 changed",
      "+line2b",
      " line3",
      "",
    ].join("\n");
    const parsed = parseDiff(raw);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0]?.path, "src/app.ts");
    assert.equal(parsed.files[0]?.status, "modified");
    assert.ok(parsed.files[0]?.hunks.some((h) => h.startsWith("@@")));
  });

  it("applies hunks to the original file", () => {
    const original = ["a", "b", "c", "d"];
    const hunks = ["@@ -1,3 +1,4 @@", " a", " b", "+b2", "-c", "+c", "+c2", " d"];
    const { lines, applied, failed } = applyHunks(original, hunks);
    assert.equal(failed, 0);
    assert.equal(applied, 1);
    assert.deepEqual(lines, ["a", "b", "b2", "c", "c2", "d"]);
  });

  it("reports a hunk that matches nothing", () => {
    const { applied, failed } = applyHunks(["x", "y"], ["@@ -1 +1 @@", "-nope", "+replaced"]);
    assert.equal(applied, 0);
    assert.equal(failed, 1);
  });

  it("tolerates a context shift", () => {
    const original = ["header1", "header2", "header3", "target", "tail"];
    const hunks = ["@@ -4 +4 @@", "-target", "+patched"];
    const { lines, applied } = applyHunks(original, hunks);
    assert.equal(applied, 1);
    assert.ok(lines.includes("patched"));
  });

  it("restores tokens and writes to the real repository", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mentat-apply-"));
    await mkdir(join(repo, "src"), { recursive: true });
    const realContent = ["def compute_acme_churn(rows):", "    return 0", ""].join("\n");
    await writeFile(join(repo, "src", "acme_billing.py"), realContent, "utf8");

    const vault = new Vault();
    const token = vault.tokenize("compute_acme_churn", "fn", "code").token;

    const raw = [
      "diff --git a/src/acme_billing.py b/src/acme_billing.py",
      "--- a/src/acme_billing.py",
      "+++ b/src/acme_billing.py",
      "@@ -1,2 +1,2 @@",
      `-def ${token}(rows):`,
      `+def ${token}(rows, retries=3):`,
      "     return 0",
      "",
    ].join("\n");

    const report = await applyDiff(parseDiff(raw), repo, vault, { write: true });
    assert.equal(report.ok, true);
    assert.equal(report.files[0]?.status, "applied");

    const after = await readFile(join(repo, "src", "acme_billing.py"), "utf8");
    assert.match(after, /def compute_acme_churn\(rows, retries=3\):/);
    assert.ok(!after.includes("zq_fn_"), "a token survived into the real file");

    await rm(repo, { recursive: true, force: true });
  });

  it("refuses a path that escapes the repository root", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mentat-esc-"));
    const vault = new Vault();
    const raw = ["diff --git a/../../etc/passwd b/../../etc/passwd", "--- a/../../etc/passwd", "+++ b/../../etc/passwd", "@@ -1 +1 @@", "-x", "+y", ""].join("\n");
    const report = await applyDiff(parseDiff(raw), repo, vault, { write: false });
    assert.equal(report.ok, false);
    assert.match(report.files[0]?.note ?? "", /escapes/);
    await rm(repo, { recursive: true, force: true });
  });

  it("captures cloud edits as a diff against the baseline", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "mentat-diff-"));
    await writeFile(join(sandbox, "a.py"), "print(1)\n", "utf8");
    const baseline = await initSandboxBaseline(sandbox);
    assert.equal(baseline.ok, true, baseline.error);

    await writeFile(join(sandbox, "a.py"), "print(1)\nprint(2)\n", "utf8");
    await writeFile(join(sandbox, "b.py"), "print(3)\n", "utf8");

    const diff = await collectSandboxDiff(sandbox);
    assert.match(diff, /print\(2\)/);
    assert.match(diff, /b\.py/);
    const parsed = parseDiff(diff);
    assert.ok(parsed.files.length >= 2);

    await rm(sandbox, { recursive: true, force: true });
  });

  it("returns an empty diff when the model changed nothing", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "mentat-nochange-"));
    await writeFile(join(sandbox, "a.py"), "print(1)\n", "utf8");
    await initSandboxBaseline(sandbox);
    const diff = await collectSandboxDiff(sandbox);
    assert.equal(diff.trim(), "");
    await rm(sandbox, { recursive: true, force: true });
  });

  it("git helper surfaces failures without throwing", async () => {
    const r = await git(tmpdir(), ["not-a-real-git-command"]);
    assert.notEqual(r.code, 0);
  });
});

describe("assertNotExfiltrated", () => {
  it("blocks payloads that reference local artifacts", () => {
    for (const bad of ["see .mentat/jobs/1", "the vault.json file", "prompt.txt contents"]) {
      assert.throws(() => assertNotExfiltrated(bad), BoundaryViolation);
    }
  });

  it("allows ordinary prompts", () => {
    assert.doesNotThrow(() => assertNotExfiltrated("Add retry logic to the ingest pipeline."));
  });
});

describe("secret file denylist", () => {
  it("classifies secret names without swallowing ordinary source", () => {
    for (const name of [
      ".env", ".env.local", ".env.production", "prod.env",
      "server.pem", "tls.key", "keystore.p12", "trust.pfx",
      "id_rsa", "id_ed25519", "id_rsa.pub",
      ".npmrc", ".netrc", ".htpasswd", ".pgpass",
      "credentials", "credentials.json", "credentials.yml",
      ".dockerconfig.json",
    ]) {
      assert.ok(isSecretFile(name), `should be treated as secret: ${name}`);
    }
    for (const name of [
      "main.py", "credentials.py", "server.pem.example", "envoy.yml",
      "package.json", "README.md", "key_generator.ts", "id.py",
    ]) {
      assert.ok(!isSecretFile(name), `should be mirrored normally: ${name}`);
    }
    assert.ok(isSecretDirectory(".aws"));
    assert.ok(isSecretDirectory(".SSH"), "directory matching is case-insensitive");
    assert.ok(isSecretDirectory(".gnupg"));
    assert.ok(!isSecretDirectory("src"));
  });

  let repo: string;
  let sandbox: string;
  let manifest: Awaited<ReturnType<typeof buildSandbox>>;

  const SECRET_VALUES = [
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "sk-abcdef0123456789abcdef0123456789abcdef",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "npm_000000000000000000000000000000000000",
    "hunter2-password",
    "AKIAIOSFODNN7EXAMPL",
  ];

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "mentat-secrets-"));
    sandbox = join(tmpdir(), `mentat-secrets-sb-${process.pid}-${Date.now()}`);
    await mkdir(join(repo, ".aws"), { recursive: true });
    await mkdir(join(repo, ".ssh"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });

    await writeFile(join(repo, ".env"), `AWS_SECRET_ACCESS_KEY=${SECRET_VALUES[0]}\n`, "utf8");
    await writeFile(join(repo, ".env.local"), `OPENAI_API_KEY=${SECRET_VALUES[1]}\n`, "utf8");
    await writeFile(join(repo, "server.pem"), `-----BEGIN PRIVATE KEY-----\n${SECRET_VALUES[2]}\n`, "utf8");
    await writeFile(join(repo, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\n", "utf8");
    await writeFile(join(repo, ".npmrc"), `//registry.npmjs.org/:_authToken=${SECRET_VALUES[3]}\n`, "utf8");
    await writeFile(join(repo, "credentials"), `${SECRET_VALUES[4]}\n`, "utf8");
    await writeFile(join(repo, ".aws", "credentials"), `[default]\naws_secret_access_key=${SECRET_VALUES[5]}\n`, "utf8");
    await writeFile(join(repo, ".ssh", "id_ed25519"), "PRIVATE KEY MATERIAL\n", "utf8");

    // Ordinary source must still be mirrored, including a legitimate
    // credentials.py module.
    await writeFile(join(repo, "src", "main.py"), "def handle():\n    return 1\n", "utf8");
    await writeFile(join(repo, "src", "credentials.py"), "DEFAULT_USER = 'service'\n", "utf8");

    manifest = await buildSandbox(new Vault(), { realRoot: repo, sandboxRoot: sandbox });
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  });

  it("never mirrors .env files, key material, or credential stores", async () => {
    for (const rel of [".env", ".env.local", "server.pem", "id_rsa", ".npmrc", "credentials"]) {
      await assert.rejects(() => readFile(join(sandbox, rel), "utf8"), `${rel} must not exist in the sandbox`);
    }
    await assert.rejects(() => readFile(join(sandbox, ".aws", "credentials"), "utf8"));
    await assert.rejects(() => readFile(join(sandbox, ".ssh", "id_ed25519"), "utf8"));
  });

  it("records every omission with an explicit secret reason", () => {
    const reasons = new Map(manifest.omissions.map((o) => [o.path, o.reason]));
    assert.match(reasons.get(".env") ?? "", /secret file/);
    assert.match(reasons.get(".env.local") ?? "", /secret file/);
    assert.match(reasons.get("server.pem") ?? "", /secret file/);
    // Secret directories are recorded at the directory level, before descent.
    assert.match(reasons.get(".aws") ?? "", /secret directory/);
    assert.match(reasons.get(".ssh") ?? "", /secret directory/);
  });

  it("still mirrors ordinary source and a legitimate credentials module", async () => {
    const mirrored = manifest.files.map((f) => f.path);
    assert.ok(mirrored.includes("src/main.py"), `expected src/main.py mirrored, got ${JSON.stringify(mirrored)}`);
    assert.ok(mirrored.includes("src/credentials.py"), `expected src/credentials.py mirrored, got ${JSON.stringify(mirrored)}`);
    // The module's constants are tokenized as usual; the file itself is not a
    // secret just because of its name.
    const text = await readFile(join(sandbox, "src", "credentials.py"), "utf8");
    assert.match(text, /service/);
  });

  it("keeps every secret value out of every mirrored byte", async () => {
    const files: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), rel);
        else files.push(rel);
      }
    };
    await walk(sandbox, "");
    for (const f of files) {
      const text = await readFile(join(sandbox, ...f.split("/")), "utf8");
      for (const secret of SECRET_VALUES) {
        assert.ok(!text.includes(secret), `${f} contains a real secret value`);
      }
    }
  });
});