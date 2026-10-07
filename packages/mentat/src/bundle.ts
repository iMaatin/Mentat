// Mock bundle: the ONLY artifact that may leave the machine.
// Build (pure): skeletonize code + synthesize data + sanitize task, then run
// the fail-closed leak gate over the exact rendered markdown. Any hit throws
// MentatLeakError and nothing is returned for the cloud.

import { stringifyCsv } from "./csv.js"
import { profileCsv, synthesizeMockRows, profileSummaryMarkdown } from "./tabular.js"
import { skeletonizeFile, rankFiles, collectIdentifierTokens, redactNetworkLiterals } from "./skeleton.js"
import { scanForLeaks, formatFindings } from "./scanner.js"
import { IdentifierVault } from "./vault.js"
import { estimateTokens } from "./tokens.js"
import { hashText, MentatLeakError } from "./audit.js"
import { DEFAULT_CONFIG, type MentatConfig } from "./config.js"

export interface BundleFileInput {
  path: string
  content: string
}

export interface BundleDatasetInput {
  name: string
  csvText: string
}

export interface PrepareInput {
  task: string
  files: BundleFileInput[]
  datasets: BundleDatasetInput[]
  /** Proprietary terms the deterministic pass can't derive (codenames, hosts…). */
  entities?: string[]
  keywords?: string[]
  seed?: string
  config?: MentatConfig
  maxMockRows?: number
}

export interface BundleFile {
  mockPath: string
  content: string
  renamed: number
  truncatedLines: number
}

export interface BundleDataset {
  mockName: string
  columns: string[]
  profileMarkdown: string
  rowsCsv: string
  mockRows: number
  realRows: number
}

export interface MockBundle {
  version: 1
  id: string
  createdAt: string
  task: string
  files: BundleFile[]
  datasets: BundleDataset[]
  tokenEstimate: number
  stats: {
    filesIncluded: number
    filesDroppedForBudget: number
    identifiersRenamed: number
    stringsRedacted: number
    commentsRedacted: number
  }
}

export interface PrepareOutput {
  bundle: MockBundle
  /** Exact markdown prompt for the cloud subagent. Scan-verified clean. */
  markdown: string
  egressSha256: string
  vault: IdentifierVault
  /** How many known proprietary terms were rewritten inside the task text. */
  taskReplacements: number
}

function taskKeywords(task: string, extra: string[] = []): string[] {
  const words = task.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []
  return [...new Set([...words, ...extra.map((keyword) => keyword.toLowerCase())])]
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const URL_SPAN = /https?:\/\/[^/\s"'<>]+/gi

/**
 * Rewrite known proprietary terms to their mocks. URL spans are skipped —
 * hosts are normalized separately by `redactNetworkLiterals`, and mangling
 * them here would corrupt allowlisted documentation URLs.
 */
export function substituteVaultSecrets(
  text: string,
  vault: IdentifierVault,
  minLength = 3,
): { text: string; replacements: number } {
  const entries = [...vault.entries()]
    .filter((entry) => entry.real.length >= minLength)
    .sort((a, b) => b.real.length - a.real.length)
  let replacements = 0
  const rewrite = (span: string): string => {
    let out = span
    for (const entry of entries) {
      const wordish = /^[A-Za-z0-9_]+$/.test(entry.real)
      const pattern = new RegExp(wordish ? `\\b${escapeRegExp(entry.real)}\\b` : escapeRegExp(entry.real), "g")
      const next = out.replace(pattern, entry.mock)
      if (next !== out) {
        replacements++
        out = next
      }
    }
    return out
  }
  URL_SPAN.lastIndex = 0
  let result = ""
  let last = 0
  let match: RegExpExecArray | null
  while ((match = URL_SPAN.exec(text)) !== null) {
    result += rewrite(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
    if (match[0].length === 0) URL_SPAN.lastIndex++
  }
  result += rewrite(text.slice(last))
  return { text: result, replacements }
}

export function renderBundleMarkdown(bundle: MockBundle, includeHeader: boolean = true): string {
  const parts: string[] = []
  if (includeHeader) {
    parts.push(`Mentat-Bundle: ${bundle.id}`)
    parts.push(`(mock workspace — all names, code, and data below are synthetic look-alikes)`)
    parts.push("")
  }
  parts.push(`# Task (sanitized)`, "", bundle.task.trim(), "")
  if (bundle.files.length > 0) {
    parts.push(`# Mock files (${bundle.files.length})`, "")
    for (const file of bundle.files) {
      parts.push(`## \`${file.mockPath}\``, "", "```", file.content.trimEnd(), "```", "")
    }
  }
  if (bundle.datasets.length > 0) {
    parts.push(`# Mock datasets (${bundle.datasets.length})`, "")
    for (const dataset of bundle.datasets) {
      parts.push(`## \`${dataset.mockName}\``, "", dataset.profileMarkdown, "")
      parts.push(`sample rows (${dataset.mockRows} of ${dataset.realRows} real):`, "", "```csv", dataset.rowsCsv.trimEnd(), "```", "")
    }
  }
  parts.push(
    "# Instructions",
    "",
    "- Solve ONLY against this mock workspace. Never ask for the real code or data — it does not exist for you.",
    "- Reply with a unified diff against the MOCK paths above, fenced as ```diff, plus numbered implementation notes.",
    "- Keep every mock identifier spelled EXACTLY as shown; do not invent real-looking names.",
    "- If something is ambiguous, state your assumption and proceed.",
    "",
  )
  return parts.join("\n")
}

export function prepareBundle(input: PrepareInput): PrepareOutput {
  const config = input.config ?? DEFAULT_CONFIG
  const seed = input.seed ?? `${Date.now()}`
  const keywords = taskKeywords(input.task, input.keywords)

  // Reserve every real token so generated mocks can never collide with reality.
  const reserved = new Set<string>()
  for (const file of input.files) {
    for (const token of collectIdentifierTokens(file.content)) reserved.add(token)
    for (const part of file.path.split("/")) reserved.add(part)
  }
  for (const dataset of input.datasets) reserved.add(dataset.name)
  for (const entity of input.entities ?? []) reserved.add(entity)
  const vault = new IdentifierVault(seed, reserved)

  for (const entity of input.entities ?? []) {
    if (entity.trim() !== "") vault.getOrCreate("entity", entity)
  }
  for (const item of config.denylist) {
    if (item.trim() !== "") vault.getOrCreate("secret", item)
  }

  const allRanked = rankFiles(input.files, keywords)
  const ranked = allRanked.slice(0, config.code.maxFiles)
  const droppedForBudget = Math.max(0, allRanked.length - ranked.length)

  const files: BundleFile[] = []
  let identifiersRenamed = 0
  let stringsRedacted = 0
  let commentsRedacted = 0
  let tokenBudget = config.code.maxBundleTokens - estimateTokens(input.task)

  for (const file of ranked) {
    const skeleton = skeletonizeFile(file.path, file.content, vault, {
      strings: config.code.strings,
      comments: config.code.comments,
      maxLines: config.code.maxLinesPerFile,
    })
    const cost = estimateTokens(skeleton.content)
    if (cost > tokenBudget && files.length > 0) continue
    tokenBudget -= cost
    identifiersRenamed += skeleton.renamed
    stringsRedacted += skeleton.redactedStrings
    commentsRedacted += skeleton.redactedComments
    files.push({
      mockPath: skeleton.mockPath,
      content: skeleton.content,
      renamed: skeleton.renamed,
      truncatedLines: skeleton.truncatedLines,
    })
  }

  const datasets: BundleDataset[] = []
  for (const dataset of input.datasets) {
    const profile = profileCsv(dataset.csvText, vault, {
      name: dataset.name,
      columnPolicy: config.data.columnPolicy,
    })
    const mock = synthesizeMockRows(profile, {
      rows: Math.min(input.maxMockRows ?? config.data.maxRows, config.data.maxRows),
      seed,
      vault,
    })
    const rowsCsv = stringifyCsv(mock.header, mock.rows, profile.delimiter)
    datasets.push({
      mockName: profile.mockName,
      columns: mock.header,
      profileMarkdown: profileSummaryMarkdown(profile, config.data.includeRealCounts),
      rowsCsv,
      mockRows: mock.rows.length,
      realRows: profile.rowCount,
    })
  }

  // The local agent writes the task against REAL names; rewrite exact known
  // proprietary terms to their mocks deterministically, then gate the result.
  // Unknown proprietary prose is a documented residual risk (see THREAT_MODEL).
  // Real identifiers can also hide inside kept strings/comments — substitute
  // there too, after the vault is complete.
  let fileSubstitutions = 0
  const substitutedFiles = files.map((file) => {
    const { text, replacements: fileReplacements } = substituteVaultSecrets(file.content, vault)
    fileSubstitutions += fileReplacements
    return { ...file, content: text }
  })
  files.length = 0
  files.push(...substitutedFiles)
  // The agent may paste real URLs/hosts into the task; normalize those first,
  // then substitute known proprietary terms.
  const networkCleanTask = redactNetworkLiterals(input.task).text
  const { text: sanitizedTask, replacements: taskReplacements } = substituteVaultSecrets(networkCleanTask, vault)
  const replacements = taskReplacements + fileSubstitutions

  const id = `b_${hashText(`${seed}\u0000${sanitizedTask}`).slice(0, 12)}`
  const bundle: MockBundle = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    task: sanitizedTask.trim(),
    files,
    datasets,
    tokenEstimate: 0,
    stats: {
      filesIncluded: files.length,
      filesDroppedForBudget: droppedForBudget,
      identifiersRenamed,
      stringsRedacted,
      commentsRedacted,
    },
  }
  const markdown = renderBundleMarkdown(bundle)
  bundle.tokenEstimate = estimateTokens(markdown)

  // FAIL-CLOSED GATE over the exact bytes that would leave the machine.
  const verdict = scanForLeaks(markdown, vault.secrets(config.minSecretLength), {
    minSecretLength: config.minSecretLength,
  })
  if (!verdict.clean) {
    throw new MentatLeakError(
      [
        "Mentat blocked egress: proprietary identifiers detected in the mock bundle.",
        "Nothing was sent anywhere. Rephrase the task or add terms via `entities`, then retry.",
        formatFindings(verdict.findings),
      ].join("\n"),
      verdict.findings,
    )
  }

  return { bundle, markdown, egressSha256: hashText(markdown), vault, taskReplacements: replacements }
}
