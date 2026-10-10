import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLocalEndpoint, resolveLocalConfig, parseLooseJson, LocalModelError, DEFAULT_BASE_URL } from "../src/client.js";

describe("assertLocalEndpoint", () => {
  it("accepts loopback addresses", () => {
    for (const url of [
      "http://127.0.0.1:1234/v1",
      "http://localhost:1234/v1",
      "http://127.0.0.2:1234/v1",
      "http://[::1]:1234/v1",
      // RFC 6761 reserves .localhost for the loopback interface.
      "http://lmstudio.localhost:1234/v1",
    ]) {
      assert.doesNotThrow(() => assertLocalEndpoint(url), `should accept ${url}`);
    }
  });

  it("rejects remote hosts", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "http://192.168.1.50:1234/v1",
      "http://gpu-host.lan:1234/v1",
      // .local is mDNS and may resolve to another machine on the network, so it
      // is deliberately not treated as loopback.
      "http://lmstudio.local:1234/v1",
    ]) {
      assert.throws(() => assertLocalEndpoint(url), LocalModelError, `should reject ${url}`);
    }
  });

  it("explains why a remote layer 1 is refused", () => {
    try {
      assertLocalEndpoint("https://api.openai.com/v1");
      assert.fail("expected a throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      assert.match(message, /would upload your prompts/);
      assert.match(message, /MENTAT_ALLOW_REMOTE_LOCAL/);
    }
  });

  it("rejects a malformed URL", () => {
    assert.throws(() => assertLocalEndpoint("not a url"), LocalModelError);
  });
});

describe("resolveLocalConfig", () => {
  it("defaults to LM Studio on loopback", () => {
    const config = resolveLocalConfig();
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.ok(config.model.length > 0);
  });

  it("reads environment overrides", () => {
    const previousModel = process.env.MENTAT_LOCAL_MODEL;
    const previousUrl = process.env.MENTAT_LOCAL_BASE_URL;
    try {
      process.env.MENTAT_LOCAL_MODEL = "qwen3-30b-a3b-instruct";
      process.env.MENTAT_LOCAL_BASE_URL = "http://127.0.0.1:9999/v1/";
      const config = resolveLocalConfig();
      assert.equal(config.model, "qwen3-30b-a3b-instruct");
      // The trailing slash must be normalized so paths join cleanly.
      assert.equal(config.baseUrl, "http://127.0.0.1:9999/v1");
    } finally {
      if (previousModel === undefined) delete process.env.MENTAT_LOCAL_MODEL;
      else process.env.MENTAT_LOCAL_MODEL = previousModel;
      if (previousUrl === undefined) delete process.env.MENTAT_LOCAL_BASE_URL;
      else process.env.MENTAT_LOCAL_BASE_URL = previousUrl;
    }
  });
});

describe("parseLooseJson", () => {
  it("parses bare JSON", () => {
    assert.deepEqual(parseLooseJson<{ a: number }>('{"a":1}'), { a: 1 });
  });

  it("parses fenced code blocks", () => {
    assert.deepEqual(parseLooseJson('```json\n{"a":2}\n```'), { a: 2 });
  });

  it("recovers JSON surrounded by prose", () => {
    assert.deepEqual(parseLooseJson('Sure! {"a":3} hope that helps'), { a: 3 });
  });

  it("repairs trailing commas", () => {
    assert.deepEqual(parseLooseJson('{"a":4,}'), { a: 4 });
    assert.deepEqual(parseLooseJson('[1,2,]'), [1, 2]);
  });

  it("throws on unrecoverable output", () => {
    assert.throws(() => parseLooseJson("I cannot help with that"), LocalModelError);
  });
});