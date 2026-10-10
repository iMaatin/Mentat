/**
 * Mentat for OpenCode.
 *
 * This plugin does not reimplement any of the privacy machinery. That lives in
 * the `mentat` CLI, which owns the vault, the mock generator, and the egress
 * scanner. The plugin has exactly two jobs:
 *
 *  1. `/mentat` runs the full pipeline in the terminal you are already in.
 *  2. A `context` hook guards the session. If you use plain OpenCode in a
 *     Mentat project, this intercepts every outbound model call and blocks it
 *     when the request carries material that should never leave the machine.
 *
 * The guard is deliberately conservative and opt-out per project. It cannot
 * know what you consider sensitive, so it applies the same deterministic rules
 * the CLI uses: known credential shapes, private addresses, and internal hosts.
 */

import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const run = promisify(execFile);

interface MentatPluginOptions {
  /** Path to the `mentat` binary. Auto-detected when omitted. */
  readonly binary?: string;
  /** Disable the outbound guard for this project. */
  readonly guard?: boolean;
  /** Extra regex sources, evaluated against every outbound request. */
  readonly extraRules?: readonly string[];
}

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * Rules duplicated from `@mentat/core` on purpose. The plugin runs inside the
 * OpenCode process, which cannot import the CLI's module graph, and the guard
 * must work even if the CLI is not installed.
 */
const DEFAULT_RULES: readonly Rule[] = [
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "api-key", pattern: /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "connection-string-creds", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi },
  { id: "private-ip", pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
  { id: "internal-host", pattern: /\b[a-z0-9-]+\.(?:internal|intranet|corp|local|lan)\b/gi },
  { id: "live-email", pattern: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

function detectBinary(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const exe = process.platform === "win32" ? "mentat.cmd" : "mentat";
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs.filter(Boolean)) {
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Flattens a request body into searchable text. */
function bodyText(body: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof body === "string") return body;
  if (Array.isArray(body)) return body.map((b) => bodyText(b, depth + 1)).join("\n");
  if (body && typeof body === "object") {
    return Object.values(body as Record<string, unknown>)
      .map((v) => bodyText(v, depth + 1))
      .join("\n");
  }
  return "";
}

export default Plugin.define({
  id: "mentat",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as MentatPluginOptions;
    const binary = detectBinary(options.binary);
    const dir = ctx.location.directory;

    const log = (message: string): void => {
      if (process.env.MENTAT_DEBUG === "1") console.log(`[mentat] ${message}`);
    };

    // --- /mentat ----------------------------------------------------------
    await ctx.command.transform((editor) => {
      editor.add({
        name: "mentat",
        description: "Run a task through Mentat: nothing from this repository leaves the machine.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const task = prompt.text.trim();
          if (!task) {
            await ctx.session.synthetic({
              sessionID,
              text: "Usage: /mentat <what you want built or fixed>",
            });
            return;
          }
          if (!binary) {
            await ctx.session.synthetic({
              sessionID,
              text:
                "Mentat CLI not found on PATH. Install it, or set `binary` in the plugin options:\n" +
                "  \"plugins\": [{ \"package\": \"mentat-oc\", \"options\": { \"binary\": \"D:/path/to/mentat.cmd\" } }]",
            });
            return;
          }
          await ctx.session.synthetic({
            sessionID,
            text: `Starting Mentat in ${dir}. Watch the sandbox work in the terminal; inspect the result with \`mentat inspect\`.`,
          });
          try {
            const { stdout } = await run(binary, ["ask", task, "--cwd", dir], {
              cwd: dir,
              maxBuffer: 32 * 1024 * 1024,
              windowsHide: true,
            });
            await ctx.session.synthetic({ sessionID, text: stdout });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await ctx.session.synthetic({
              sessionID,
              text: `Mentat exited with an error:\n${message}`,
            });
          }
        },
      });
    });

    // --- Outbound guard ---------------------------------------------------
    if (options.guard === false) {
      log("outbound guard disabled by configuration");
      return;
    }

    const rules: Rule[] = [
      ...DEFAULT_RULES,
      ...(options.extraRules ?? []).map((source, i) => {
        try {
          return { id: `custom-${i}`, pattern: new RegExp(source, "g") };
        } catch {
          log(`ignoring invalid custom rule ${i}`);
          return null;
        }
      }).filter((r): r is Rule => r !== null),
    ];

    let blocked = 0;

    await ctx.session.hook("context", (event) => {
      const text = bodyText(event.messages);
      if (text.length === 0) return;

      const hits: string[] = [];
      for (const rule of rules) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(text)) hits.push(rule.id);
      }
      if (hits.length === 0) return;

      blocked += 1;
      // Replace the request with a refusal. The hook cannot reject a request,
      // so the most honest available action is to strip the payload and leave
      // the model with an explanation instead of the data.
      event.messages = [
        {
          role: "system",
          content: [
            {
              type: "text",
              text:
                "This request was blocked by the Mentat egress guard. The outgoing payload " +
                `matched: ${hits.join(", ")}.\n\n` +
                "Mentat exists so that proprietary code and data never reach a cloud model. " +
                'Run the task through `mentat ask "<request>"` instead: it will build a ' +
                "synthetic mirror of this repository, send only that, and apply the result here.\n\n" +
                "To disable this guard for a project, set guard:false in the plugin options.",
            },
          ],
        },
      ] as unknown as typeof event.messages;
      log(`blocked an outbound request matching ${hits.join(", ")}`);
    });

    log(`ready: binary=${binary ?? "not found"}, rules=${rules.length}, location=${resolve(dir)}`);
  },
});