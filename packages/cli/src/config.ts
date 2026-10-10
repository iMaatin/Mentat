/**
 * Configuration loading.
 *
 * Config is a JSONC file at `.mentat/config.json` or `~/.config/mentat/config.json`,
 * merged over built-in defaults. Secrets are never stored here: the cloud layer
 * uses whatever credentials `opencode` already has, and the local layer needs
 * no credential at all.
 */

import { readFile } from "node:fs/promises";
import { existsSync as existsSyncSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

export interface MentatConfig {
  /** opencode model reference for layer 2, e.g. `anthropic/claude-sonnet-4-5`. */
  readonly cloudModel: string;
  /** opencode agent for layer 2. `build` allows edits; `plan` does not. */
  readonly cloudAgent: string;
  readonly localModel: string;
  readonly localBaseUrl: string;
  /** Synthetic rows generated per mocked dataset. */
  readonly mockRows: number;
  /** Seed for reproducible mocks. */
  readonly seed: number;
  /** Extra exclude patterns applied when mirroring. */
  readonly exclude: readonly string[];
  /** Dataset paths relative to the repo root that should always be mocked. */
  readonly dataGlobs: readonly string[];
  /**
   * Columns whose values must be replaced in generated data. Names, emails,
   * phones, addresses, and free-text columns go here.
   */
  readonly sensitiveColumns: readonly string[];
  /** Show every mirrored and mocked file rather than a summary. */
  readonly verbose: boolean;
  /** Apply the resulting patch without confirmation. */
  readonly autoApply: boolean;
}

export const DEFAULT_CONFIG: MentatConfig = {
  cloudModel: "anthropic/claude-sonnet-4-5",
  cloudAgent: "build",
  localModel: "qwen3-30b-a3b",
  localBaseUrl: "http://127.0.0.1:1234/v1",
  mockRows: 200,
  seed: 20260101,
  exclude: [],
  dataGlobs: [],
  sensitiveColumns: ["name", "full_name", "first_name", "last_name", "email", "address", "phone", "ssn", "notes", "comment", "description", "message"],
  verbose: false,
  autoApply: false,
};

/** Strips `//` and `/* *\/` comments so JSONC parses as JSON. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export function findConfigFile(startDir: string): string | null {
  const candidates = [
    join(startDir, ".mentat", "config.json"),
    join(homedir(), ".config", "mentat", "config.json"),
  ];
  return candidates.find((c) => existsSyncSync(c)) ?? null;
}

export async function loadConfig(startDir: string): Promise<{ config: MentatConfig; path: string | null }> {
  const path = findConfigFile(startDir);
  if (!path) return { config: DEFAULT_CONFIG, path: null };

  const raw = await readFile(path, "utf8");
  let parsed: Partial<MentatConfig>;
  try {
    parsed = JSON.parse(stripJsonComments(raw)) as Partial<MentatConfig>;
  } catch (err) {
    throw new Error(
      `Could not parse ${path}: ${err instanceof Error ? err.message : String(err)}\n` +
        `The file may use JSON with comments; only true comments are stripped, so a trailing comma will fail.`,
    );
  }

  const envOverrides: { -readonly [K in keyof MentatConfig]?: MentatConfig[K] } = {};
  if (process.env.MENTAT_CLOUD_MODEL) envOverrides.cloudModel = process.env.MENTAT_CLOUD_MODEL;
  if (process.env.MENTAT_LOCAL_MODEL) envOverrides.localModel = process.env.MENTAT_LOCAL_MODEL;
  if (process.env.MENTAT_LOCAL_BASE_URL) envOverrides.localBaseUrl = process.env.MENTAT_LOCAL_BASE_URL;

  return {
    config: {
      ...DEFAULT_CONFIG,
      ...parsed,
      ...envOverrides,
      exclude: [...(parsed.exclude ?? []), ...(DEFAULT_CONFIG.exclude)],
      dataGlobs: parsed.dataGlobs ?? [...DEFAULT_CONFIG.dataGlobs],
      sensitiveColumns: parsed.sensitiveColumns ?? [...DEFAULT_CONFIG.sensitiveColumns],
    },
    path,
  };
}

export function jobsRoot(projectRoot: string): string {
  return resolve(join(projectRoot, ".mentat", "jobs"));
}

/**
 * The sandbox lives outside the repository by default. A directory under the
 * user's home or temp is chosen so that a stray `..` in a path cannot reach the
 * project, and so the sandbox never ends up inside the project it mirrors.
 */
export function sandboxBase(projectRoot: string): string {
  const explicit = process.env.MENTAT_SANDBOX_ROOT;
  const base = explicit
    ? resolve(explicit)
    : process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? homedir(), "Mentat", "sandboxes")
      : join(homedir(), ".mentat", "sandboxes");
  return resolve(base);
}

export function projectRootFor(startDir: string): string {
  return resolve(startDir);
}

export { dirname };