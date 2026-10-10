/**
 * Layer 1: the local model.
 *
 * Talks to LM Studio's OpenAI-compatible endpoint directly rather than going
 * through a coding agent, for two reasons:
 *
 *  1. Independence. Mentat must work with no agent installed. The local model is
 *     not an optional extra for the privacy story; it *is* the privacy story.
 *  2. Control. These calls are narrow and single-shot. We need the raw text back,
 *     not a session, not tool calls, and not an agent that might wander into the
 *     repository.
 *
 * The endpoint never leaves 127.0.0.1 unless the operator explicitly points
 * MENTAT_LOCAL_BASE_URL elsewhere, which `assertLocalEndpoint` guards.
 */

export interface LocalClientOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface LocalMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LocalCompletion {
  readonly text: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly durationMs: number;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const DEFAULT_MODEL = "qwen3-30b-a3b";

export class LocalModelUnavailable extends Error {
  constructor(baseUrl: string, detail?: string) {
    super(
      `Cannot reach the local model at ${baseUrl}.\n` +
        (detail ? `  ${detail}\n` : "") +
        `  - Is LM Studio running with its local server enabled (Developer tab)?\n` +
        `  - Set MENTAT_LOCAL_BASE_URL if it listens elsewhere.\n` +
        `  - Set MENTAT_LOCAL_MODEL if the loaded model has another name.\n` +
        `Mentat refuses to fall back to a cloud model for layer 1. That fallback ` +
        `would send your code to a server, which defeats the purpose.`,
    );
    this.name = "LocalModelUnavailable";
  }
}

export class LocalModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalModelError";
  }
}

/**
 * Enforces that layer 1 talks to a loopback address.
 *
 * This is the check that makes the two-layer design sound: if the local layer
 * were silently pointed at a remote endpoint, every prompt you wrote would leave
 * the machine before Mentat's redaction even ran. Fail loudly instead.
 */
export function assertLocalEndpoint(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LocalModelError(`MENTAT_LOCAL_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host.endsWith(".localhost");
  if (!loopback) {
    throw new LocalModelError(
      `Layer 1 must run on this machine, but MENTAT_LOCAL_BASE_URL points at ${url.hostname}.\n` +
        `A remote layer 1 would upload your prompts and code before Mentat could\n` +
        `redact anything. Use a loopback address, or set MENTAT_ALLOW_REMOTE_LOCAL=1\n` +
        `if you understand exactly what that waives.`,
    );
  }
}

export function resolveLocalConfig(overrides: LocalClientOptions = {}): Required<Omit<LocalClientOptions, "apiKey">> & { apiKey: string } {
  const baseUrl = overrides.baseUrl ?? process.env.MENTAT_LOCAL_BASE_URL ?? DEFAULT_BASE_URL;
  if (process.env.MENTAT_ALLOW_REMOTE_LOCAL !== "1") assertLocalEndpoint(baseUrl);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: overrides.model ?? process.env.MENTAT_LOCAL_MODEL ?? DEFAULT_MODEL,
    apiKey: overrides.apiKey ?? process.env.MENTAT_LOCAL_API_KEY ?? "lm-studio",
    timeoutMs: overrides.timeoutMs ?? Number(process.env.MENTAT_LOCAL_TIMEOUT_MS ?? 300_000),
    temperature: overrides.temperature ?? 0.2,
    maxTokens: overrides.maxTokens ?? 4096,
  };
}

/**
 * Extracts an endpoint-level error body into a message, or null when absent.
 *
 * Two shapes are real in the wild: OpenAI's `{error: {message}}` and LM
 * Studio's bare `{error: "..."}`, which it returns with HTTP 200 for any path
 * it does not serve — most often a `localBaseUrl` missing its `/v1` suffix.
 * Read naively that body parses fine and yields an empty response list, so the
 * misconfiguration surfaces as "server is up but reports no models" instead of
 * the actual reason.
 */
function endpointErrorMessage(raw: unknown): string | null {
  if (raw == null) return null;
  let message: string;
  if (typeof raw === "string") {
    message = raw;
  } else if (typeof raw === "object") {
    const nested = (raw as { message?: unknown }).message;
    message = typeof nested === "string" && nested.length > 0 ? nested : JSON.stringify(raw);
  } else {
    message = String(raw);
  }
  if (message.trim().length === 0) return null;
  if (/unexpected endpoint|not found|unknown (?:path|endpoint|route)/i.test(message)) {
    message += "\nHint: the OpenAI-compatible API lives under /v1 — check that localBaseUrl ends with /v1.";
  }
  return message;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class LocalModel {
  private readonly config: ReturnType<typeof resolveLocalConfig>;

  constructor(overrides: LocalClientOptions = {}) {
    this.config = resolveLocalConfig(overrides);
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get model(): string {
    return this.config.model;
  }

  /** Lists loaded models. Used by `mentat doctor`. */
  async listModels(): Promise<readonly string[]> {
    const res = await this.request("/models", { method: "GET" });
    if (!res.ok) throw new LocalModelError(`Local model endpoint returned HTTP ${res.status} for /models.`);
    const parsed = parseJsonLoose<{ data?: Array<{ id?: string }>; error?: unknown }>(res.text);
    const endpointError = endpointErrorMessage(parsed.error);
    if (endpointError) throw new LocalModelError(endpointError);
    return (parsed.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
  }

  async isReachable(): Promise<{ ok: boolean; detail?: string; models?: readonly string[] }> {
    try {
      const models = await this.listModels();
      return { ok: true, models };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async chat(
    messages: readonly LocalMessage[],
    options: { temperature?: number; maxTokens?: number; stop?: readonly string[]; json?: boolean } = {},
  ): Promise<LocalCompletion> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      stream: false,
    };
    if (options.stop) body.stop = [...options.stop];
    if (options.json) body.response_format = { type: "json_object" };

    let parsed = await this.sendChat(body);
    let endpointError = endpointErrorMessage(parsed.error);
    // Some llama.cpp builds (the server under LM Studio) reject `json_object`
    // outright: "'response_format.type' must be 'json_schema' or 'text'".
    // Every JSON task — term extraction, prompt rewrite, dataset naming —
    // would then fail on that server. The system prompt already demands a bare
    // JSON value and the parser tolerates chatter, so dropping the structural
    // hint is a fallback, not a degradation.
    if (endpointError !== null && options.json && /response_format/i.test(endpointError)) {
      delete body.response_format;
      parsed = await this.sendChat(body);
      endpointError = endpointErrorMessage(parsed.error);
    }
    if (endpointError !== null) throw new LocalModelError(endpointError);

    const choice = parsed.choices?.[0];
    const text = choice?.message?.content ?? "";
    return {
      text: typeof text === "string" ? text : "",
      model: this.config.model,
      tokensIn: parsed.usage?.prompt_tokens ?? 0,
      tokensOut: parsed.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - started,
    };
  }

  /** Sends one chat request and parses the body. Does not interpret errors. */
  private async sendChat(body: Record<string, unknown>): Promise<ChatResponse> {
    const res = await this.request("/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return parseJsonLoose<ChatResponse>(res.text);
  }

  /** Asks for JSON and parses it, tolerating fenced code blocks. */
  async chatJson<T>(messages: readonly LocalMessage[], options: { temperature?: number; maxTokens?: number } = {}): Promise<T> {
    const instruction =
      "Respond with a single valid JSON value and nothing else. No prose, no explanation, " +
      "no markdown code fences. Your entire reply must parse with JSON.parse.";
    // The instruction rides on the existing leading system message instead of
    // being appended as a second system turn. Qwen-family chat templates raise
    // "System message must be at the beginning" for any system message after
    // position 0, which would fail every JSON task (term extraction, prompt
    // rewrite, dataset naming) on those models.
    const [first] = messages;
    const merged: LocalMessage[] =
      first && first.role === "system"
        ? [{ role: "system", content: `${first.content}\n\n${instruction}` }, ...messages.slice(1)]
        : [{ role: "system", content: instruction }, ...messages];
    const completion = await this.chat(merged, { ...options, json: true });
    return parseLooseJson<T>(completion.text);
  }

  private async request(
    pathname: string,
    init: { method: string; body?: string },
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl}${pathname}`, {
        method: init.method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: init.body,
        // A loopback endpoint that redirects would silently send the prompt —
        // and the bearer header — off-machine. Refuse redirects outright; the
        // only acceptable layer-1 server answers directly.
        redirect: "error",
        signal: controller.signal,
      });
      // The body is read here, while the timeout is still armed. Returning the
      // Response instead would clear the timer before the caller consumed the
      // stream, leaving a stalled body to hang forever.
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LocalModelError(`Local model timed out after ${this.config.timeoutMs}ms. Is a model loaded in LM Studio?`);
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new LocalModelUnavailable(
        this.config.baseUrl,
        `${detail} (note: redirects are refused; a 3xx answer from the endpoint is treated as unavailable)`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Parses a response body, turning a malformed payload into a `LocalModelError`
 * with a bounded excerpt instead of a raw SyntaxError. LM Studio answers with
 * HTML on several failure paths (proxy pages, error handlers), and a bare parse
 * crash there would obscure which layer actually failed.
 */
function parseJsonLoose<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LocalModelError(`Local model returned a non-JSON response. First 200 chars:\n${text.slice(0, 200)}`);
  }
}

/**
 * Parses JSON that may be wrapped in fences or trailed by chatter. Local models
 * are instructed to reply with bare JSON, but small models drift, and a hard
 * parse failure here would discard an otherwise good sanitization pass.
 */
export function parseLooseJson<T>(text: string): T {
  const trimmed = text.trim();
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  candidates.push(trimmed);

  // The model may have wrapped its answer in prose: "Sure! {...} hope that
  // helps". Slicing from the opening brace to the end of the string does not
  // work in that case, because the trailing prose is still attached. Extract a
  // balanced JSON extent instead.
  const start = firstOpener(trimmed);
  if (start !== -1) {
    const balanced = extractBalanced(trimmed, start);
    if (balanced) candidates.push(balanced);
  }

  for (const candidate of candidates) {
    const parsed = tryParse<T>(candidate);
    if (parsed.ok) return parsed.value;
  }
  throw new LocalModelError(
    `Local model did not return valid JSON. First 200 chars:\n${trimmed.slice(0, 200)}`,
  );
}

function tryParse<T>(candidate: string): { ok: true; value: T } | { ok: false } {
  if (!candidate) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(candidate) as T };
  } catch {
    // Trailing commas are the most common small-model slip.
    const repaired = candidate.replace(/,(\s*[}\]])/g, "$1");
    try {
      return { ok: true, value: JSON.parse(repaired) as T };
    } catch {
      return { ok: false };
    }
  }
}

function firstOpener(text: string): number {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

/**
 * Returns the balanced `{...}` or `[...]` beginning at `start`, or null.
 * String literals are tracked so a brace inside a value does not end the scan.
 */
function extractBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  if (open !== "{" && open !== "[") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}