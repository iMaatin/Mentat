// Mentat — two-layer private agentic coding.
//
// Layer 1 (local, LM Studio): this session. Owns real code/data, builds
// sanitized mock bundles via `mentat_prepare`, reintegrates cloud answers.
// Layer 2 (cloud): the `mentat-cloud` subagent (no tools) which only ever
// sees mock bundles. Two deterministic hooks fail closed on leaks:
//   1. `tool.execute.before` scans every `mentat-cloud` task prompt against
//      the session vault before the subagent is spawned.
//   2. `chat.message` scans any message bound for a NON-local provider
//      against all known session vaults.

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile, appendFile, readdir, chmod, stat } from "node:fs/promises"
import { join, resolve, relative, sep } from "node:path"
import {
  DEFAULT_CONFIG,
  parseConfigText,
  isLocalProvider,
  prepareBundle,
  reintegrateCloudOutput,
  scanForLeaks,
  formatFindings,
  auditLine,
  hashText,
  probeLmStudio,
  IdentifierVault,
  type MentatConfig,
  type VaultJSON,
} from "../../packages/mentat/src/index.js"

const MAX_CODE_FILE_BYTES = 512 * 1024

function safeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

async function loadMentatConfig(root: string, fallback: string): Promise<{ config: MentatConfig; source: string }> {
  for (const dir of [root, fallback]) {
    for (const name of ["mentat.json", join(".opencode", "mentat.json")]) {
      const text = await readTextIfExists(join(dir, name))
      if (text !== undefined) {
        try {
          return { config: parseConfigText(text), source: join(dir, name) }
        } catch {
          // Fall through to defaults; mentat_status will surface the parse error.
          return { config: DEFAULT_CONFIG, source: `${join(dir, name)} (INVALID JSON — using defaults)` }
        }
      }
    }
  }
  return { config: DEFAULT_CONFIG, source: "(built-in defaults)" }
}

async function listVaults(vaultsDir: string): Promise<{ sessionID: string; vault: IdentifierVault }[]> {
  const out: { sessionID: string; vault: IdentifierVault }[] = []
  let names: string[] = []
  try {
    names = await readdir(vaultsDir)
  } catch {
    return out
  }
  for (const name of names.slice(0, 50)) {
    if (!name.endsWith(".json")) continue
    const text = await readTextIfExists(join(vaultsDir, name))
    if (text === undefined) continue
    try {
      const json = JSON.parse(text) as VaultJSON
      out.push({ sessionID: name.slice(0, -".json".length), vault: IdentifierVault.fromJSON(json) })
    } catch {
      continue
    }
  }
  return out
}

function partText(part: unknown): string {
  if (typeof part !== "object" || part === null) return ""
  const record = part as Record<string, unknown>
  return typeof record["text"] === "string" ? (record["text"] as string) : ""
}

function resolveInside(root: string, raw: string): string | undefined {
  const abs = resolve(root, raw)
  const rel = relative(root, abs)
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === "..") return undefined
  return abs
}

export const MentatPlugin: Plugin = async ({ directory, worktree }) => {
  const root = worktree !== "" ? worktree : directory
  const { config, source: configSource } = await loadMentatConfig(directory, root)
  const mentatDir = join(root, ".mentat")
  const vaultsDir = join(mentatDir, "vaults")
  const bundlesDir = join(mentatDir, "bundles")
  const auditPath = join(mentatDir, "audit.log.jsonl")

  async function audit(record: Parameters<typeof auditLine>[0]): Promise<void> {
    await mkdir(mentatDir, { recursive: true })
    await appendFile(auditPath, auditLine(record), "utf8")
  }

  return {
    tool: {
      mentat_status: tool({
        description:
          "Check Mentat Layer-1 readiness: LM Studio reachability + loaded models, active config, vault/bundle counts. Run first.",
        args: {},
        async execute() {
          const probe = await probeLmStudio(config.lmstudio.baseUrl, config.lmstudio.timeoutMs)
          let vaultCount = 0
          try {
            vaultCount = (await readdir(vaultsDir)).length
          } catch {
            vaultCount = 0
          }
          const lines = [
            `## Mentat status`,
            ``,
            `- LM Studio: ${probe.ok ? `UP (${probe.models.join(", ") || "no models listed"})` : `DOWN — ${probe.error ?? "unknown error"}`}`,
            `- LM Studio URL: ${config.lmstudio.baseUrl}`,
            `- Config: ${configSource}`,
            `- Cloud agent: \`${config.cloudAgent}\` (tools denied, mock workspace only)`,
            `- Column policy: \`${config.data.columnPolicy}\` | mock rows: ${config.data.maxRows} | max files: ${config.code.maxFiles}`,
            `- Local providers (egress guard allowlist): ${config.localProviders.join(", ")}`,
            `- Session vaults on disk: ${vaultCount}`,
            ``,
            probe.ok
              ? `Layer 1 is ready. Set your session model to an \`lmstudio/*\` model (\`/models\`), then run \`/mentat <task>\`.`
              : `Start LM Studio's local server (default port 1234, OpenAI-compatible endpoint), load a model, and retry.`,
          ]
          return lines.join("\n")
        },
      }),

      mentat_prepare: tool({
        description:
          "LAYER 1 GATEKEEPER. Build a sanitized mock bundle (mock code + small mock data + rewritten task) for the cloud. Reads REAL files locally, runs the fail-closed leak gate, persists the vault under .mentat/ (never leaves the machine). Returns the mock prompt to forward VERBATIM to the cloud subagent via the task tool.",
        args: {
          task: tool.schema.string().describe("The task in your own words (may reference real names; they get rewritten)."),
          files: tool.schema.array(tool.schema.string()).describe("Real code files (absolute or relative to session cwd)."),
          dataFiles: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Real CSV datasets (absolute or relative to session cwd). Only a small mock is forwarded."),
          entities: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Extra proprietary terms to treat as secrets (codenames, hosts, client names)."),
          keywords: tool.schema.array(tool.schema.string()).optional().describe("Extra relevance keywords for file ranking."),
          maxMockRows: tool.schema.number().optional().describe("Override mock rows per dataset."),
        },
        async execute(args, context) {
          const base = context.directory !== "" ? context.directory : root
          const codeInputs: { path: string; content: string }[] = []
          for (const raw of args.files) {
            const abs = resolveInside(base, raw) ?? resolve(base, raw)
            const info = await stat(abs)
            if (!info.isFile()) throw new Error(`Mentat: not a file: ${raw}`)
            if (info.size > MAX_CODE_FILE_BYTES) throw new Error(`Mentat: file too large (>512KB): ${raw}`)
            const content = await readFile(abs, "utf8")
            codeInputs.push({ path: relative(root, abs) !== "" ? relative(root, abs) : raw, content })
          }
          const dataInputs: { name: string; csvText: string }[] = []
          for (const raw of args.dataFiles ?? []) {
            const abs = resolveInside(base, raw) ?? resolve(base, raw)
            const info = await stat(abs)
            if (!info.isFile()) throw new Error(`Mentat: not a file: ${raw}`)
            const handle = await readFile(abs, "utf8").then(
              (text) => text.slice(0, config.data.maxProfileBytes),
              () => {
                throw new Error(`Mentat: cannot read dataset: ${raw}`)
              },
            )
            void info
            dataInputs.push({ name: relative(root, abs) !== "" ? relative(root, abs) : raw, csvText: handle })
          }

          const seed = `${context.sessionID}:${Date.now()}`
          const { bundle, markdown, egressSha256, vault, taskReplacements } = prepareBundle({
            task: args.task,
            files: codeInputs,
            datasets: dataInputs,
            entities: args.entities,
            keywords: args.keywords,
            maxMockRows: args.maxMockRows,
            seed,
            config,
          })

          await mkdir(vaultsDir, { recursive: true })
          await mkdir(join(bundlesDir, safeSegment(context.sessionID)), { recursive: true })
          const vaultPath = join(vaultsDir, `${safeSegment(context.sessionID)}.json`)
          await writeFile(vaultPath, JSON.stringify(vault.toJSON()), "utf8")
          try {
            await chmod(vaultPath, 0o600)
          } catch {
            // Best effort (Windows has no POSIX modes).
          }
          const bundleDir = join(bundlesDir, safeSegment(context.sessionID))
          await writeFile(join(bundleDir, `${bundle.id}.md`), markdown, "utf8")
          await writeFile(join(bundleDir, `${bundle.id}.json`), JSON.stringify(bundle), "utf8")
          await audit({
            timestamp: new Date().toISOString(),
            sessionID: context.sessionID,
            bundleID: bundle.id,
            phase: "prepare",
            verdict: "allow",
            egressSha256,
            stats: {
              files: bundle.files.length,
              datasets: bundle.datasets.length,
              renamed: bundle.stats.identifiersRenamed,
              taskReplacements,
              tokens: bundle.tokenEstimate,
            },
          })

          return [
            `# Mock bundle \`${bundle.id}\` ready (gate: CLEAN, sha256 ${egressSha256.slice(0, 12)}…)`,
            ``,
            `- files: ${bundle.files.length} (renamed ${bundle.stats.identifiersRenamed} identifiers, redacted ${bundle.stats.stringsRedacted} strings, dropped ${bundle.stats.filesDroppedForBudget} for budget)`,
            `- datasets: ${bundle.datasets.length} (mock rows: ${bundle.datasets.map((d) => d.mockRows).join(", ") || "—"})`,
            `- task terms rewritten: ${taskReplacements} | est. tokens: ~${bundle.tokenEstimate}`,
            `- vault: \`.mentat/vaults/${safeSegment(context.sessionID)}.json\` (LOCAL ONLY, never forward this)`,
            ``,
            `## Next step (do exactly this)`,
            ``,
            `Call the \`task\` tool with \`subagent_type: "${config.cloudAgent}"\` and paste the ENTIRE mock prompt below as the task \`prompt\` VERBATIM — add NOTHING (no real names, paths, or data):`,
            ``,
            `--- MOCK PROMPT START ---`,
            markdown,
            `--- MOCK PROMPT END ---`,
          ].join("\n")
        },
      }),

      mentat_reintegrate: tool({
        description:
          "LAYER 1 UNPACKER. Translate cloud output from MOCK space back to REAL identifiers/paths. Verifies no mock tokens survive and flags unknown references. Does NOT apply changes — apply via edit tools, review, and test.",
        args: {
          bundleID: tool.schema.string().describe("Bundle id from mentat_prepare (e.g. b_abc123...)."),
          cloudOutput: tool.schema.string().describe("The verbatim output returned by the cloud subagent."),
        },
        async execute(args, context) {
          const vaultText = await readTextIfExists(join(vaultsDir, `${safeSegment(context.sessionID)}.json`))
          if (vaultText === undefined) {
            throw new Error("Mentat: no vault for this session. Run mentat_prepare first.")
          }
          const vault = IdentifierVault.fromJSON(JSON.parse(vaultText) as VaultJSON)
          const report = reintegrateCloudOutput(args.cloudOutput, vault)
          await audit({
            timestamp: new Date().toISOString(),
            sessionID: context.sessionID,
            bundleID: args.bundleID,
            phase: "reintegrate",
            verdict: report.leftoverMocks.length === 0 ? "allow" : "deny",
            stats: { mapped: report.mapped, unmapped: report.unmappedMocks.length },
          })
          const warnings =
            report.warnings.length > 0 || report.unmappedMocks.length > 0
              ? [
                  ``,
                  `## Warnings (review before applying)`,
                  ...report.warnings.map((warning) => `- ${warning}`),
                  ...(report.unmappedMocks.length > 0
                    ? [`- cloud invented ${report.unmappedMocks.length} unknown mock token(s): ${report.unmappedMocks.join(", ")}`]
                    : []),
                  ...(report.leftoverMocks.length > 0
                    ? [`- UNMAPPED mock tokens remain: ${report.leftoverMocks.join(", ")}`]
                    : []),
                ]
              : []
          return [
            `# Reintegrated to real space (mapped ${report.mapped} token(s))`,
            ``,
            "```diff",
            report.realText,
            "```",
            ...warnings,
            ``,
            `Apply via edit/write tools, run the relevant tests, and summarize for the user.`,
          ].join("\n")
        },
      }),
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      const args = output.args as { subagent_type?: unknown; prompt?: unknown } | undefined
      if (args?.subagent_type !== config.cloudAgent) return
      const prompt = typeof args.prompt === "string" ? args.prompt : ""
      const vaultText = await readTextIfExists(join(vaultsDir, `${safeSegment(input.sessionID)}.json`))
      if (vaultText === undefined) {
        await audit({
          timestamp: new Date().toISOString(),
          sessionID: input.sessionID,
          bundleID: "unknown",
          phase: "blocked",
          verdict: "deny",
          cloudAgent: config.cloudAgent,
          findingRules: ["missing-vault"],
        })
        throw new Error(
          `Mentat blocked: no vault for this session. Run mentat_prepare first — only its mock prompt may be sent to ${config.cloudAgent}.`,
        )
      }
      const vault = IdentifierVault.fromJSON(JSON.parse(vaultText) as VaultJSON)
      const verdict = scanForLeaks(prompt, vault.secrets(config.minSecretLength), {
        minSecretLength: config.minSecretLength,
      })
      await audit({
        timestamp: new Date().toISOString(),
        sessionID: input.sessionID,
        bundleID: /^Mentat-Bundle: (\S+)/m.exec(prompt)?.[1] ?? "unknown",
        phase: "send",
        verdict: verdict.clean ? "allow" : "deny",
        cloudAgent: config.cloudAgent,
        egressSha256: hashText(prompt),
        findingRules: [...new Set(verdict.findings.map((finding) => finding.rule))],
      })
      if (!verdict.clean) {
        throw new Error(
          [
            `Mentat blocked: the ${config.cloudAgent} prompt contains proprietary identifiers.`,
            `Forward ONLY the mentat_prepare mock prompt verbatim — do not add real names, paths, or data.`,
            formatFindings(verdict.findings),
          ].join("\n"),
        )
      }
    },

    "chat.message": async (input, output) => {
      const providerID = input.model?.providerID
      // Local models are Layer 1: they may see everything. Only police egress.
      if (!providerID || isLocalProvider(providerID, config)) return
      const vaults = await listVaults(vaultsDir)
      if (vaults.length === 0) return
      const secrets: string[] = []
      for (const { vault } of vaults) {
        for (const secret of vault.secrets(config.minSecretLength)) {
          secrets.push(secret)
          if (secrets.length >= 20000) break
        }
        if (secrets.length >= 20000) break
      }
      const text = output.parts.map(partText).join("\n")
      if (text.trim() === "") return
      const verdict = scanForLeaks(text, secrets, { minSecretLength: config.minSecretLength })
      if (!verdict.clean) {
        await audit({
          timestamp: new Date().toISOString(),
          sessionID: input.sessionID,
          bundleID: "unknown",
          phase: "blocked",
          verdict: "deny",
          findingRules: [...new Set(verdict.findings.map((finding) => finding.rule))],
        })
        throw new Error(
          [
            `Mentat blocked: message to cloud provider "${providerID}" contains proprietary identifiers.`,
            `Keep real code/data in your local (LM Studio) session; use /mentat for cloud help.`,
            formatFindings(verdict.findings),
          ].join("\n"),
        )
      }
    },
  }
}
