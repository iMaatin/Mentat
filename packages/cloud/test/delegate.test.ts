import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Vault } from "@mentat/core";
import { buildPrompt, parseNdjson, finalText } from "../src/delegate.js";
import { delegate } from "../src/delegate.js";

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