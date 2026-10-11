/**
 * Layer 2: delegating to the cloud model.
 *
 * The sandbox is a disposable working tree and the cloud model is invoked as a
 * headless agent inside it. `opencode run` is used rather than a raw API call
 * because it gives the model a full agent loop with file, search, and shell
 * tools against the mock, which is what makes it able to actually make the
 * change rather than merely describe it.
 *
 * The critical ordering constraint: the egress gate runs *before* the child
 * process is spawned. If the payload fails the scan, we never start a process
 * that would transmit it.
 */

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { Vault, assertClean, assertNotExfiltrated, LeakDetected, type ScanReport } from "@mentat/core";

export interface CloudConfig {
  /** OpenCode model reference, e.g. `anthropic/claude-sonnet-4-5`. */
  readonly model: string;
  readonly agent?: string;
  /** Extra arguments appended verbatim. Use sparingly. */
  readonly extraArgs?: readonly string[];
  readonly timeoutMs?: number;
  /** Path to the opencode executable. Discovered when omitted. */
  readonly binary?: string;
  readonly standalone?: boolean;
}

export interface DelegateOptions {
  readonly sandboxRoot: string;
  /** The task as the cloud model will see it. Already de-identified. */
  readonly prompt: string;
  readonly vault: Vault;
  readonly config: CloudConfig;
  readonly logger?: (message: string) => void;
  /** Stream the model's output to the terminal. */
  readonly verbose?: boolean;
  /**
   * The caller already showed the user the Gate 2 findings and they approved
   * sending anyway. Gate 2 then records the findings instead of blocking.
   * Gate 1 (local-only artifact references) ignores this entirely.
   */
  readonly allowFindings?: boolean;
  /**
   * Called when Gate 2 finds something and `allowFindings` is not set. The
   * callback receives the exact report the gate saw; return true to send
   * anyway. Declining — or never being called — leaves the run blocked.
   */
  readonly reviewEgress?: (report: ScanReport) => Promise<boolean>;
}

export interface DelegateResult {
  readonly ok: boolean;
  readonly exitCode: number;
  /** Newline-delimited JSON events, when the run used `--format json`. */
  readonly events: readonly CloudEvent[];
  readonly stdout: string;
  readonly stderr: string;
  /** Result of the pre-flight egress scan. */
  readonly egress: ScanReport;
  /** Bytes of payload handed to the cloud model, for the cost report. */
  readonly payloadBytes: number;
  readonly durationMs: number;
  /** Set when the run was blocked before any process started. */
  readonly blocked?: string;
  /** True when findings were sent with an explicit human approval. */
  readonly egressApproved?: boolean;
}

export interface CloudEvent {
  readonly type?: string;
  readonly [key: string]: unknown;
}

/** Per-stream ceiling on captured child output, for the report and the parser. */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export class EgressBlocked extends Error {
  readonly report: ScanReport;
  constructor(report: ScanReport) {
    super(
      `Egress blocked before the cloud model was contacted.\n` +
        report.findings
          .map((f) => `  [${f.severity}] ${f.rule} x${f.count}: ${f.advice}`)
          .join("\n"),
    );
    this.name = "EgressBlocked";
    this.report = report;
  }
}

const CANDIDATES_WINDOWS = [
  join(process.env.LOCALAPPDATA ?? "", "Programs", "@opencodedesktop", "resources", "opencode-cli.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Programs", "opencode", "opencode.exe"),
  join(process.env.APPDATA ?? "", "npm", "opencode.cmd"),
];

const CANDIDATES_POSIX = [
  "/usr/local/bin/opencode",
  "/usr/bin/opencode",
  join(process.env.HOME ?? "", ".opencode", "bin", "opencode"),
];

function isWindows(): boolean {
  return process.platform === "win32";
}

function pathExtList(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").filter((e) => e.length > 0);
}

/**
 * Resolves one candidate file name, appending PATHEXT extensions on Windows.
 *
 * A bare `opencode` on PATH is usually an npm shim: a file actually named
 * `opencode.cmd`. Extension-less probing finds nothing, which is half of why
 * `opencode: command not found` happens on Windows even when the CLI works in
 * a terminal.
 */
function resolveWithExtensions(base: string, env: NodeJS.ProcessEnv): string | null {
  if (!isWindows()) return existsSync(base) ? base : null;
  try {
    if (existsSync(base) && statSync(base).isFile()) return base;
  } catch {
    /* fall through to extension search */
  }
  for (const ext of pathExtList(env)) {
    const candidate = base + ext;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolves a command to an absolute path via PATH and PATHEXT.
 *
 * Written by hand rather than relying on the shell because there must be no
 * shell anywhere on this path: the whole point is to control exactly which
 * bytes reach the spawned process.
 */
export function resolveCommand(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!cmd) return null;
  if (/[\\/]/.test(cmd)) return resolveWithExtensions(cmd, env);
  const dirs = (env.PATH ?? "").split(isWindows() ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    const found = resolveWithExtensions(join(dir, cmd), env);
    if (found) return found;
  }
  return null;
}

/** True for the batch shims npm installs on Windows. */
export function isBatchFile(bin: string): boolean {
  return /\.(?:cmd|bat)$/i.test(bin);
}

function comspec(env: NodeJS.ProcessEnv = process.env): string {
  return env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
}

/**
 * Quotes one argument for a `cmd /c` command line.
 *
 * Arguments made of path-safe characters pass through bare; everything else is
 * double-quoted with embedded quotes backslash-escaped, which is what the
 * target of an npm `.cmd` shim (a Node script) expects. cmd's own parser does
 * not treat `%` as escapable inside quotes, so a prompt containing an existing
 * environment-variable reference such as `%PATH%` would be expanded by cmd;
 * that is a documented limitation of the batch shim, and setting
 * `MENTAT_OPENCODE_BIN` to a real executable removes it entirely.
 */
export function quoteForCmd(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_\-.:\\/=,@+]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** Full `cmd /c` command line for `bin` with `args`, each part quoted as needed. */
export function buildWindowsCommandLine(bin: string, args: readonly string[]): string {
  return [bin, ...args].map(quoteForCmd).join(" ");
}

/**
 * Locates the opencode binary.
 *
 * The desktop app ships a CLI binary that is not on PATH on Windows, which is a
 * common source of "opencode: command not found" even though the user has the
 * app installed. Probing the known install locations saves that confusion.
 */
export function findOpenCode(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.MENTAT_OPENCODE_BIN;
  if (explicit) return resolveWithExtensions(explicit, env) ?? explicit;

  const candidates = isWindows() ? CANDIDATES_WINDOWS : CANDIDATES_POSIX;

  const fromPath = resolveCommand("opencode", env);
  if (fromPath) return fromPath;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolveWithExtensions(candidate, env);
    if (resolved) return resolved;
  }
  return null;
}

function probeBinary(candidate: string): boolean {
  if (!candidate) return false;
  try {
    if (isWindows() && isBatchFile(candidate)) {
      // Spawning a `.cmd` directly with `shell: false` throws EINVAL on Node
      // >= 18.20/20.12/22 (the CVE-2024-27980 mitigation), so the shim must be
      // driven through cmd.exe explicitly.
      const r = spawnSync(comspec(), ["/d", "/s", "/c", `"${buildWindowsCommandLine(candidate, ["--version"])}"`], {
        stdio: "ignore",
        timeout: 15_000,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      return !r.error && r.status === 0;
    }
    const r = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
      shell: false,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

export async function requireOpenCode(config: CloudConfig): Promise<string> {
  const found = config.binary ? (resolveCommand(config.binary) ?? config.binary) : findOpenCode();
  if (!found) {
    throw new Error(
      "Could not find the opencode CLI.\n" +
        "  Install it, or set MENTAT_OPENCODE_BIN to its path.\n" +
        "  Mentat needs opencode to run the cloud layer; the local layer does not use it.",
    );
  }
  try {
    await access(found, constants.X_OK);
  } catch {
    // Windows relies on PATHEXT rather than the executable bit.
    if (process.platform !== "win32") throw new Error(`opencode at ${found} is not executable.`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Environment passed to the cloud child
// ---------------------------------------------------------------------------

/**
 * The minimum an agent process needs to start: locate its own binaries, write
 * temp files, and find the user's home directory.
 */
const BASE_ENV_ALLOWLIST = [
  "PATH", "PATHEXT", "COMSPEC", "SystemRoot", "SYSTEMROOT", "WINDIR",
  "TEMP", "TMP",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "TZ",
];

/**
 * Provider credentials the cloud layer needs to authenticate.
 *
 * Passing nothing breaks layer 2 outright — opencode has no key to present —
 * so the choice is not "secrets or no secrets" but *which* secrets. These
 * variables are exactly the provider API keys opencode reads, and nothing
 * else: the agent inside the sandbox never sees AWS keys, GitHub tokens, or
 * corporate SSO material that happen to sit in the developer's environment.
 * `MENTAT_CLOUD_EXTRA_ENV` names additional variables explicitly, one per
 * comma/semicolon separator, for providers not listed here.
 */
const PROVIDER_ENV_ALLOWLIST = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION",
  "OPENROUTER_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY",
  "MISTRAL_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "COHERE_API_KEY",
  "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "PERPLEXITY_API_KEY",
  "MOONSHOT_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT",
];

/**
 * Builds the child's environment from an allowlist.
 *
 * The previous implementation forwarded `...process.env` wholesale, which
 * handed the cloud agent — a process with a shell inside the sandbox — every
 * secret in the developer's environment. `env` inside the sandbox prints them
 * all, and they leave with the next tool call. An allowlist is the only shape
 * that matches the threat model: everything not explicitly needed stays here.
 */
export function buildChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const wanted = new Set([...BASE_ENV_ALLOWLIST, ...PROVIDER_ENV_ALLOWLIST]);
  // Case-insensitive match on Windows: the same variable may surface as
  // `SystemRoot` or `SYSTEMROOT` depending on how the process was started.
  const lower = new Map([...wanted].map((k) => [k.toLowerCase(), k]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const canonical = lower.get(key.toLowerCase());
    if (canonical) out[canonical] = value;
  }
  for (const extra of (env.MENTAT_CLOUD_EXTRA_ENV ?? "").split(/[,;]/)) {
    const name = extra.trim();
    if (name.length === 0) continue;
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  // Keep the sandbox session from reaching anything network-bound beyond the
  // model provider itself, and keep output parseable.
  out.MENTAT_SANDBOX = "1";
  out.NO_COLOR = "1";
  return out;
}

/**
 * The fixed instruction block the cloud model always receives.
 *
 * It is prose we wrote, but it is English — and aggressive comment
 * tokenization can mint a vault entry that collides with one of its words
 * (e.g. "directory"). A raw collision would block every run of a project
 * whose vault happens to contain it, so the block is sanitized against the
 * vault when one is supplied.
 */
export const PROMPT_INSTRUCTIONS =
  "You are working inside a synthetic mirror of a real codebase. The identifiers beginning " +
  "with `zq_` are the real identifiers in this project: use them exactly as written, and do " +
  "not attempt to guess or expand what they stand for. Infer intent from how they are used.\n\n" +
  "Make the requested change by editing the files in this directory. Run the tests if they " +
  "exist and fix what you break. Do not describe the change instead of making it.\n";

/**
 * Builds the instruction the cloud model receives.
 *
 * When a vault is supplied, the instruction block and context are sanitized
 * (real identifiers → tokens). The task is deliberately NOT sanitized here:
 * an unsanitized task reaching this point is an upstream bug, and Gate 2
 * must catch it rather than silently repair it.
 */
export function buildPrompt(task: string, context?: string, vault?: Vault): string {
  const base = vault ? vault.sanitize(PROMPT_INSTRUCTIONS) : PROMPT_INSTRUCTIONS;
  const extra = vault && context ? vault.sanitize(context) : context;
  return extra ? `${base}\nAdditional context:\n${extra}\n\nTask:\n${task}` : `${base}\nTask:\n${task}`;
}

/**
 * Runs the cloud layer with the egress gate in front of it.
 *
 * Order is deliberate and load-bearing:
 *   1. assertNotExfiltrated - the payload must not reference local artifacts.
 *   2. assertClean          - no real identifier, secret, or PII in the payload.
 *   3. spawn                - only now may anything leave the machine.
 */
export async function delegate(options: DelegateOptions): Promise<DelegateResult> {
  const log = options.logger ?? (() => {});
  const started = Date.now();
  // Sanitizes the instruction block (see buildPrompt); the task passes through
  // so Gate 2 below still catches an upstream that skipped its own sanitize.
  const prompt = buildPrompt(options.prompt, undefined, options.vault);
  const payloadBytes = Buffer.byteLength(prompt, "utf8");

  // --- Gate 1: local-only artifact references -------------------------------
  try {
    assertNotExfiltrated(prompt);
  } catch (err) {
    const report: ScanReport = { ok: false, findings: [], rulesRun: [] };
    return {
      ok: false,
      exitCode: -1,
      events: [],
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      egress: report,
      payloadBytes,
      durationMs: Date.now() - started,
      blocked: err instanceof Error ? err.message : String(err),
    };
  }

  // --- Gate 2: content scan -------------------------------------------------
  let egress: ScanReport;
  let egressApproved = false;
  try {
    egress = assertClean(prompt, options.vault, { redact: true });
  } catch (err) {
    const scanReport: ScanReport = err instanceof LeakDetected ? err.report : { ok: false, findings: [], rulesRun: [] };
    // A human decision, not a retry: the reviewer sees exactly what the gate
    // saw — rule, severity, count, excerpt — and either accepts the leak or
    // leaves the run blocked. Gate 1 above never routes through here.
    egressApproved =
      options.allowFindings === true || (await options.reviewEgress?.(scanReport)) === true;
    if (!egressApproved) {
      return {
        ok: false,
        exitCode: -1,
        events: [],
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        egress: scanReport,
        payloadBytes,
        durationMs: Date.now() - started,
        blocked: err instanceof Error ? err.message : String(err),
      };
    }
    egress = scanReport;
  }

  if (egress.ok) {
    log(`  egress clear (${payloadBytes} bytes, ${egress.rulesRun.length} rules)`);
  } else {
    // The findings travel with the run: report.json keeps them, marked as
    // approved, so the decision is auditable after the fact.
    log(`  egress approved (${payloadBytes} bytes, ${egress.findings.length} finding(s) accepted)`);
  }

  // --- Gate 3: only now may we contact the cloud ----------------------------
  const bin = await requireOpenCode(options.config);
  const args = buildArgs(options.config, prompt);

  const spawnOptions: SpawnOptions = {
    cwd: options.sandboxRoot,
    windowsHide: true,
    env: buildChildEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  };

  return await new Promise<DelegateResult>((resolvePromise) => {
    // A `.cmd` shim cannot be spawned directly on Node >= 20.12: the
    // CVE-2024-27980 mitigation makes that EINVAL. Drive it through cmd.exe
    // with an explicitly quoted command line instead of reaching for
    // `shell: true`, which would re-inject the shell this code otherwise
    // avoids entirely.
    const useComspec = isWindows() && isBatchFile(bin);
    const child = useComspec
      ? spawn(
          comspec(),
          ["/d", "/s", "/c", `"${buildWindowsCommandLine(bin, args)}"`],
          { ...spawnOptions, windowsVerbatimArguments: true },
        )
      : spawn(bin, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      stderr += `\n[mentat] timed out after ${options.config.timeoutMs ?? 1_800_000}ms; terminating.\n`;
      child.kill();
    }, options.config.timeoutMs ?? 1_800_000);

    // A runaway agent can emit far past what the report should carry. Cap the
    // in-memory copy; the streams are drained either way, so the child never
    // blocks on a full pipe.
    const append = (current: string, text: string, truncated: boolean): [string, boolean] => {
      if (truncated) return [current, true];
      const next = current.length < MAX_CAPTURE_BYTES ? current + text : current;
      return [next, next.length >= MAX_CAPTURE_BYTES];
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      [stdout, stdoutTruncated] = append(stdout, text, stdoutTruncated);
      if (options.verbose) process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      [stderr, stderrTruncated] = append(stderr, text, stderrTruncated);
      if (options.verbose) process.stderr.write(text);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        exitCode: -1,
        events: [],
        stdout,
        stderr: `${stderr}\n[mentat] failed to start ${bin}: ${err.message}`,
        egress,
        payloadBytes,
        durationMs: Date.now() - started,
        egressApproved: egressApproved || undefined,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutTruncated) stdout += `\n[mentat] stdout truncated at ${MAX_CAPTURE_BYTES} bytes\n`;
      if (stderrTruncated) stderr += `\n[mentat] stderr truncated at ${MAX_CAPTURE_BYTES} bytes\n`;
      const events = parseNdjson(stdout);
      resolvePromise({
        ok: code === 0,
        exitCode: code ?? -1,
        events,
        stdout,
        stderr,
        egress,
        payloadBytes,
        durationMs: Date.now() - started,
        egressApproved: egressApproved || undefined,
      });
    });
  });
}

function buildArgs(config: CloudConfig, prompt: string): string[] {
  const args = ["run"];
  if (config.standalone) args.push("--standalone");
  args.push("--model", config.model);
  if (config.agent) args.push("--agent", config.agent);
  args.push("--format", "json");
  if (config.extraArgs) args.push(...config.extraArgs);
  args.push(prompt);
  return args;
}

/**
 * Parses newline-delimited JSON. Falls back to a single JSON object and, failing
 * that, returns an empty list: a run whose output we cannot parse is still a run
 * whose filesystem changes we can recover via git.
 */
export function parseNdjson(text: string): CloudEvent[] {
  const events: CloudEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as CloudEvent);
    } catch {
      continue;
    }
  }
  return events;
}

/** Extracts the final assistant text from a run's events, when present. */
export function finalText(events: readonly CloudEvent[]): string | null {
  let best: string | null = null;
  for (const event of events) {
    const text = findText(event);
    if (typeof text === "string" && text.trim().length > 0) best = text;
  }
  return best;
}

/**
 * The best one-line explanation for a failed cloud run.
 *
 * opencode in `--format json` reports failures as an `error` event on stdout —
 * `{"type":"error","error":{"type":"provider.no-route","message":"…"}}` — and
 * its stderr stays empty, so surfacing stderr alone produced the useless
 * "Cloud run exited 1: ". Preference order: stderr when it has content, the
 * first error event, then the tail of stdout.
 */
export function failureSummary(result: Pick<DelegateResult, "events" | "stderr" | "stdout">): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr.slice(0, 800);
  for (const event of result.events) {
    if (event.type !== "error") continue;
    const error = event.error;
    if (typeof error === "string") return error.slice(0, 800);
    if (typeof error === "object" && error !== null) {
      const { type, message } = error as { type?: unknown; message?: unknown };
      const parts = [typeof type === "string" ? type : "", typeof message === "string" ? message : ""].filter(Boolean);
      if (parts.length > 0) return parts.join(": ").slice(0, 800);
    }
  }
  return result.stdout.trim().slice(-800);
}

/**
 * Keys whose values are model output rather than event metadata.
 *
 * This list is deliberately closed. An earlier version also walked every value
 * in the event, which meant an event with no text at all resolved to its `type`
 * field and `finalText` cheerfully reported the string `"step"` as the model's
 * answer. Metadata must never be mistaken for content.
 */
const TEXT_KEYS = new Set(["text", "content", "output", "result", "answer", "reasoning"]);

function findText(value: unknown, depth = 0, underTextKey = false): string | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    return underTextKey && value.trim().length > 0 ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findText(item, depth + 1, underTextKey);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      // Traverse everything, because text is usually nested under a structural
      // key such as `part`. Only *accept* strings that sit under a text key.
      const found = findText(nested, depth + 1, underTextKey || TEXT_KEYS.has(key));
      if (found) return found;
    }
  }
  return null;
}

export { delimiter as pathDelimiter };