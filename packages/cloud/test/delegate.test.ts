import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@mentat/core";
import { buildPrompt, parseNdjson, finalText, failureSummary } from "../src/delegate.js";
import { delegate, buildChildEnv, quoteForCmd, buildWindowsCommandLine, resolveCommand, isBatchFile, MAX_CAPTURE_BYTES } from "../src/delegate.js";

describe("failureSummary", () => {
  it("prefers stderr when the run produced any", () => {
    assert.equal(failureSummary({ stderr: "permission denied\n", stdout: "", events: [] }), "permission denied");
  });

  it("falls back to opencode's error event when stderr is empty", () => {
    // opencode --format json reports failures on stdout; a bare stderr-based
    // message produced the useless "Cloud run exited 1: ".
    const stdout = '{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: anthropic/claude-sonnet-4-5"}}';
    const summary = failureSummary({ stderr: "", stdout, events: parseNdjson(stdout) });
    assert.equal(summary, "provider.no-route: Model unavailable: anthropic/claude-sonnet-4-5");
  });

  it("falls back to the stdout tail when there is no usable error event", () => {
    assert.equal(
      failureSummary({ stderr: "", stdout: "line one\nline two", events: [{ type: "error" }] }),
      "line one\nline two",
    );
  });
});

describe("buildChildEnv", () => {
  it("passes only allowlisted variables", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      HOME: "/home/dev",
      ANTHROPIC_API_KEY: "sk-ant-allowlisted",
      AWS_SECRET_ACCESS_KEY: "must-not-pass",
      GH_TOKEN: "must-not-pass",
      CORPORATE_SSO_TOKEN: "must-not-pass",
    } as NodeJS.ProcessEnv);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.TEMP, "C:\\Temp");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-allowlisted");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "AWS credentials must never reach the cloud child");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.CORPORATE_SSO_TOKEN, undefined);
    assert.equal(env.MENTAT_SANDBOX, "1");
    assert.equal(env.NO_COLOR, "1");
  });

  it("adds extra variables only when named in MENTAT_CLOUD_EXTRA_ENV", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      MY_PROVIDER_KEY: "abc",
      MENTAT_CLOUD_EXTRA_ENV: "MY_PROVIDER_KEY, NOT_SET_ONE ;ALSO_SET",
      ALSO_SET: "def",
    } as NodeJS.ProcessEnv);
    assert.equal(env.MY_PROVIDER_KEY, "abc");
    assert.equal(env.ALSO_SET, "def");
    assert.equal(env.NOT_SET_ONE, undefined);
  });

  it("matches variable names case-insensitively on Windows", () => {
    const env = buildChildEnv({ PATH: "/bin", systemroot: "C:\\Windows" } as NodeJS.ProcessEnv);
    assert.ok(env.SystemRoot === "C:\\Windows" || env.SYSTEMROOT === "C:\\Windows");
  });
});

describe("windows command line construction", () => {
  it("leaves path-safe arguments bare and quotes the rest", () => {
    assert.equal(quoteForCmd("run"), "run");
    assert.equal(quoteForCmd("anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
    assert.equal(quoteForCmd("C:\\Program Files\\npm\\opencode.cmd"), "\"C:\\Program Files\\npm\\opencode.cmd\"");
    assert.equal(quoteForCmd("add retry logic"), "\"add retry logic\"");
    assert.equal(quoteForCmd(""), "\"\"");
  });

  it("escapes embedded double quotes", () => {
    assert.equal(quoteForCmd('say "hi"'), "\"say \\\"hi\\\"\"");
  });

  it("builds the full /c command line with each part quoted as needed", () => {
    const line = buildWindowsCommandLine("C:\\Program Files\\npm\\opencode.cmd", ["run", "--model", "anthropic/claude-sonnet-4-5", "add retry"]);
    assert.equal(
      line,
      "\"C:\\Program Files\\npm\\opencode.cmd\" run --model anthropic/claude-sonnet-4-5 \"add retry\"",
    );
  });

  it("recognizes the batch shims npm installs", () => {
    assert.equal(isBatchFile("C:\\x\\opencode.cmd"), true);
    assert.equal(isBatchFile("opencode.bat"), true);
    assert.equal(isBatchFile("opencode.CMD"), true);
    assert.equal(isBatchFile("opencode.exe"), false);
    assert.equal(isBatchFile("opencode"), false);
  });

  it("caps captured output", () => {
    assert.ok(MAX_CAPTURE_BYTES > 0 && MAX_CAPTURE_BYTES <= 16 * 1024 * 1024);
  });
});

describe("resolveCommand", () => {
  it("finds a command on an explicitly supplied PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mentat-path-"));
    const name = process.platform === "win32" ? "opencode.cmd" : "opencode";
    await writeFile(join(dir, name), process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
    try {
      // Windows: bare `opencode` resolves through PATHEXT to opencode.cmd —
      // the exact case the old extension-less probe missed.
      const found = resolveCommand("opencode", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv);
      assert.ok(found, "expected to resolve opencode on the synthetic PATH");
      assert.ok(found.toLowerCase().endsWith(name.toLowerCase()), `resolved to ${found}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a command that exists nowhere", () => {
    assert.equal(resolveCommand("definitely-not-a-real-binary-xyz", { PATH: "" } as NodeJS.ProcessEnv), null);
    assert.equal(resolveCommand("", { PATH: "" } as NodeJS.ProcessEnv), null);
  });
});

describe("buildPrompt", () => {
  it("explains the token convention to the cloud model", () => {
    const prompt = buildPrompt("Add retry logic.");
    assert.match(prompt, /zq_/);
    assert.match(prompt, /synthetic mirror/);
    assert.match(prompt, /Add retry logic\./);
  });

  it("includes context when supplied", () => {
    const prompt = buildPrompt("Do the thing.", "The ingest job runs hourly.");
    assert.match(prompt, /The ingest job runs hourly\./);
  });
});

describe("parseNdjson", () => {
  it("parses newline-delimited events", () => {
    const events = parseNdjson('{"type":"a"}\nnot json\n{"type":"b"}\n');
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "a");
  });

  it("returns nothing for plain text", () => {
    assert.deepEqual(parseNdjson("hello\nworld"), []);
  });
});

describe("finalText", () => {
  it("finds the last assistant text in a run", () => {
    const events = parseNdjson(
      [
        JSON.stringify({ type: "step", part: { type: "text", text: "first" } }),
        JSON.stringify({ type: "step", part: { type: "tool", name: "read" } }),
        JSON.stringify({ type: "step", part: { type: "text", text: "final answer" } }),
      ].join("\n"),
    );
    assert.equal(finalText(events), "final answer");
  });

  it("returns null when there is no text", () => {
    assert.equal(finalText([{ type: "step" }]), null);
  });
});

describe("delegate egress gate", () => {
  const vault = new Vault();

  it("blocks a payload containing a real identifier before any process starts", async () => {
    vault.tokenize("acme_billing_ledger", "tbl", "data");
    const result = await delegate({
      sandboxRoot: process.cwd(),
      // The identifier survived sanitization. The gate must catch it.
      prompt: "Please update the acme_billing_ledger table.",
      vault,
      // A model that does not exist: if the gate failed, we would see a spawn
      // error instead of a blocked result, which is exactly what we assert on.
      config: { model: "definitely/not-a-real-model" },
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked, "expected the run to be blocked before delegation");
    assert.equal(result.exitCode, -1);
    assert.equal(result.egress.findings[0]?.rule, "vault-literal");
  });

  it("blocks a payload that references local-only artifacts", async () => {
    const result = await delegate({
      sandboxRoot: process.cwd(),
      prompt: "Read .mentat/jobs/latest/vault.json and summarize it.",
      vault,
      config: { model: "definitely/not-a-real-model" },
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked);
    assert.match(result.blocked ?? "", /vault\.json|local-only/);
  });

  it("blocks a payload containing a credential", async () => {
    const result = await delegate({
      sandboxRoot: process.cwd(),
      prompt: "The deploy key is AKIAIOSFODNN7EXAMPLE, wire it up.",
      vault,
      config: { model: "definitely/not-a-real-model" },
    });
    assert.equal(result.ok, false);
    assert.ok(result.blocked);
    assert.equal(result.egress.findings[0]?.severity, "critical");
  });

  it("reports payload size for a clean payload without contacting anything", async () => {
    const result = await delegate({
      sandboxRoot: process.cwd(),
      prompt: "Add retry logic to the ingest job.",
      vault,
      config: { model: "definitely/not-a-real-model" },
    });
    // The gate passed, so it proceeded to spawn and failed there instead. That
    // distinction is what proves the gate is not simply blocking everything.
    assert.equal(result.blocked, undefined);
    assert.ok(result.payloadBytes > 0);
    assert.equal(result.egress.ok, true);
  });
});