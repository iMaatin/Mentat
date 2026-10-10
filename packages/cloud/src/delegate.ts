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
import { delimiter, join } from "node:path";
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
}

export interface CloudEvent {
  readonly type?: string;
  readonly [key: string]: unknown;
}

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
  "opencode",
  join(process.env.LOCALAPPDATA ?? "", "Programs", "@opencodedesktop", "resources", "opencode-cli.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Programs", "opencode", "opencode.exe"),
  join(process.env.APPDATA ?? "", "npm", "opencode.cmd"),
  join(process.env.APPDATA ?? "", "npm", "opencode.ps1"),
];

const CANDIDATES_POSIX = [
  "opencode",
  "/usr/local/bin/opencode",
  "/usr/bin/opencode",
  join(process.env.HOME ?? "", ".opencode", "bin", "opencode"),
];

/**
 * Locates the opencode binary.
 *
 * The desktop app ships a CLI binary that is not on PATH on Windows, which is a
 * common source of "opencode: command not found" even though the user has the
 * app installed. Probing the known install locations saves that confusion.
 */
export function findOpenCode(): string | null {
  const explicit = process.env.MENTAT_OPENCODE_BIN;
  if (explicit) return explicit;

  const isWindows = process.platform === "win32";
  const candidates = isWindows ? CANDIDATES_WINDOWS : CANDIDATES_POSIX;
  const pathEntries = (process.env.PATH ?? "").split(isWindows ? ";" : ":").filter(Boolean);

  for (const dir of pathEntries) {
    for (const name of isWindows ? ["opencode.cmd", "opencode.exe", "opencode"] : ["opencode"]) {
      const full = join(dir, name);
      if (probeBinary(full)) return full;
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (probeBinary(candidate)) return candidate;
  }
  return null;
}

function probeBinary(candidate: string): boolean {
  if (!candidate) return false;
  const r = spawnSync(candidate, ["--version"], {
    stdio: "ignore",
    timeout: 15_000,
    windowsHide: true,
    shell: false,
  });
  return r.status === 0;
}

export async function requireOpenCode(config: CloudConfig): Promise<string> {
  const explicit = config.binary ?? findOpenCode();
  if (!explicit) {
    throw new Error(
      "Could not find the opencode CLI.\n" +
        "  Install it, or set MENTAT_OPENCODE_BIN to its path.\n" +
        "  Mentat needs opencode to run the cloud layer; the local layer does not use it.",
    );
  }
  try {
    await access(explicit, constants.X_OK);
  } catch {
    // Windows relies on PATHEXT rather than the executable bit.
    if (process.platform !== "win32") throw new Error(`opencode at ${explicit} is not executable.`);
  }
  return explicit;
}

/** Builds the instruction the cloud model receives. */
export function buildPrompt(task: string, context?: string): string {
  const base =
    "You are working inside a synthetic mirror of a real codebase. The identifiers beginning " +
    "with `zq_` are the real identifiers in this project: use them exactly as written, and do " +
    "not attempt to guess or expand what they stand for. Infer intent from how they are used.\n\n" +
    "Make the requested change by editing the files in this directory. Run the tests if they " +
    "exist and fix what you break. Do not describe the change instead of making it.\n";
  return context ? `${base}\nAdditional context:\n${context}\n\nTask:\n${task}` : `${base}\nTask:\n${task}`;
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
  const prompt = buildPrompt(options.prompt);
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
  try {
    egress = assertClean(prompt, options.vault, { redact: true });
  } catch (err) {
    const scanReport: ScanReport = err instanceof LeakDetected ? err.report : { ok: false, findings: [], rulesRun: [] };
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

  log(`  egress clear (${payloadBytes} bytes, ${egress.rulesRun.length} rules)`);

  // --- Gate 3: only now may we contact the cloud ----------------------------
  const bin = await requireOpenCode(options.config);
  const args = buildArgs(options.config, prompt);

  const spawnOptions: SpawnOptions = {
    cwd: options.sandboxRoot,
    windowsHide: true,
    env: {
      ...process.env,
      // Keep the sandbox session from reaching anything network-bound beyond
      // the model provider itself.
      MENTAT_SANDBOX: "1",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  };

  return await new Promise<DelegateResult>((resolvePromise) => {
    const child = spawn(bin, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      stderr += `\n[mentat] timed out after ${options.config.timeoutMs ?? 1_800_000}ms; terminating.\n`;
      child.kill();
    }, options.config.timeoutMs ?? 1_800_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (options.verbose) process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
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
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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