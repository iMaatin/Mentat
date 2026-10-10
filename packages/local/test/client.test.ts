import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { assertLocalEndpoint, resolveLocalConfig, parseLooseJson, LocalModelError, LocalModelUnavailable, LocalModel, DEFAULT_BASE_URL } from "../src/client.js";

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** Runs `fn` against a throwaway loopback server, then tears it down. */
async function withServer(handler: HttpHandler, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

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

describe("LocalModel transport hardening", () => {
  it("refuses a redirecting endpoint instead of following it off-machine", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, { location: "http://example.com/collect" });
        res.end();
      },
      async (baseUrl) => {
        const model = new LocalModel({ baseUrl, timeoutMs: 5_000 });
        // `redirect: "error"` means the prompt and its bearer header never
        // follow the 302 to wherever it points.
        await assert.rejects(
          () => model.listModels(),
          (err: unknown) => {
            assert.ok(err instanceof LocalModelUnavailable, `expected LocalModelUnavailable, got ${String(err)}`);
            assert.match(err.message, /redirects are refused/);
            return true;
          },
        );
      },
    );
  });

  it("times out while the response body is stalled", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"data":[');
        // Headers arrived; the body never completes. The timeout must still
        // cover the read — clearing it when the headers landed would hang here.
      },
      async (baseUrl) => {
        const model = new LocalModel({ baseUrl, timeoutMs: 400 });
        await assert.rejects(
          () => model.listModels(),
          (err: unknown) => {
            assert.ok(err instanceof LocalModelError, `expected LocalModelError, got ${String(err)}`);
            assert.match(err.message, /timed out after 400ms/);
            return true;
          },
        );
      },
    );
  });

  it("surfaces a string-typed endpoint error instead of an empty model list", async () => {
    // LM Studio answers HTTP 200 with {"error":"..."} for paths it does not
    // serve. That used to read as "server up, no models" instead of the cause.
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unexpected endpoint or method. (GET /models)" }));
      },
      async (baseUrl) => {
        const model = new LocalModel({ baseUrl, timeoutMs: 5_000 });
        await assert.rejects(
          () => model.listModels(),
          (err: unknown) => {
            assert.ok(err instanceof LocalModelError, `expected LocalModelError, got ${String(err)}`);
            assert.match(err.message, /Unexpected endpoint/);
            assert.match(err.message, /ends with \/v1/);
            return true;
          },
        );
      },
    );
  });

  it("surfaces a string-typed error from chat as a failure, not empty text", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unexpected endpoint or method. (POST /chat/completions)" }));
      },
      async (baseUrl) => {
        const model = new LocalModel({ baseUrl, timeoutMs: 5_000 });
        await assert.rejects(() => model.chat([{ role: "user", content: "hi" }]), LocalModelError);
      },
    );
  });

  it("retries without response_format when the server rejects json_object", async () => {
    // llama.cpp builds under LM Studio answer:
    //   {'error': "'response_format.type' must be 'json_schema' or 'text'"}
    // with HTTP 200. Every JSON task would fail there without this fallback.
    let sawResponseFormat = false;
    await withServer(
      (req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          const sent = JSON.parse(raw || "{}") as { response_format?: unknown };
          if (sent.response_format) {
            sawResponseFormat = true;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "'response_format.type' must be 'json_schema' or 'text'" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: '{"terms":["billing"]}' } }] }));
        });
      },
      async (baseUrl) => {
        const model = new LocalModel({ baseUrl, timeoutMs: 5_000 });
        const out = await model.chatJson<{ terms: string[] }>([{ role: "user", content: "terms?" }]);
        assert.deepEqual(out, { terms: ["billing"] });
        assert.equal(sawResponseFormat, true, "the first attempt should carry response_format");
      },
    );
  });

  it("keeps the system message first when asking for JSON", async () => {
    // Qwen-family templates raise "System message must be at the beginning"
    // for any system turn after position 0 — appending the JSON instruction as
    // its own trailing system message failed every JSON task on those models.
    let sent: { messages?: Array<{ role: string; content: string }> } = {};
    await withServer(
      (req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          sent = JSON.parse(raw || "{}") as typeof sent;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
        });
      },
      async (baseUrl) => {
        const model = new LocalModel({ baseUrl, timeoutMs: 5_000 });
        const out = await model.chatJson<{ ok: boolean }>([
          { role: "system", content: "You extract terms." },
          { role: "user", content: "file body" },
        ]);
        assert.deepEqual(out, { ok: true });
        const messages = sent.messages ?? [];
        assert.deepEqual(
          messages.map((m) => m.role),
          ["system", "user"],
        );
        assert.match(messages[0]?.content ?? "", /single valid JSON value/);
        assert.match(messages[0]?.content ?? "", /You extract terms\./);
      },
    );
  });

  it("parses a healthy response end to end", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "qwen3-test" }] }));
      },
      async (baseUrl) => {
        const model = new LocalModel({ baseUrl });
        assert.deepEqual([...(await model.listModels())], ["qwen3-test"]);
      },
    );
  });
});