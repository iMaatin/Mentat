// Mentat configuration: project-local `mentat.json` (or `.opencode/mentat.json`)
// merged over these defaults. Safe to commit — it holds policy, never secrets.

export type ColumnPolicy = "keep" | "alias" | "hash"
export type StringPolicy = "keep" | "redact-secrets" | "elide"

export interface MentatConfig {
  version: 1
  /** Provider IDs treated as local (never trigger the cloud egress guard). */
  localProviders: string[]
  lmstudio: {
    baseUrl: string
    timeoutMs: number
  }
  /** Name of the cloud subagent (must match `.opencode/agent/<name>.md`). */
  cloudAgent: string
  code: {
    maxFiles: number
    maxLinesPerFile: number
    maxBundleTokens: number
    strings: StringPolicy
    comments: StringPolicy
  }
  data: {
    columnPolicy: ColumnPolicy
    maxRows: number
    /** Profile only the first N bytes of each dataset (streaming later). */
    maxProfileBytes: number
    includeRealCounts: boolean
  }
  /** Extra always-secret strings (project-specific codenames, hosts, …). */
  denylist: string[]
  minSecretLength: number
}

export const DEFAULT_CONFIG: MentatConfig = {
  version: 1,
  localProviders: ["lmstudio", "ollama", "llama.cpp", "llamacpp", "local", "vllm", "mlx"],
  lmstudio: {
    baseUrl: "http://127.0.0.1:1234/v1",
    timeoutMs: 5000,
  },
  cloudAgent: "mentat-cloud",
  code: {
    maxFiles: 12,
    maxLinesPerFile: 400,
    maxBundleTokens: 12000,
    strings: "redact-secrets",
    comments: "keep",
  },
  data: {
    columnPolicy: "alias",
    maxRows: 60,
    maxProfileBytes: 8 * 1024 * 1024,
    includeRealCounts: true,
  },
  denylist: [],
  minSecretLength: 4,
}

export function isLocalProvider(providerID: string, config: MentatConfig = DEFAULT_CONFIG): boolean {
  return config.localProviders.some((local) => local.toLowerCase() === providerID.trim().toLowerCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stripJsonComments(raw: string): string {
  let out = ""
  let i = 0
  let inString = false
  while (i < raw.length) {
    const char = raw[i]
    const next = raw[i + 1]
    if (inString) {
      out += char
      if (char === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (char === '"') inString = false
      i++
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      i++
      continue
    }
    if (char === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++
      continue
    }
    if (char === "/" && next === "*") {
      i += 2
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += char
    i++
  }
  return out
}

function mergeConfig(base: MentatConfig, override: unknown): MentatConfig {
  if (!isRecord(override)) return base
  const merged: MentatConfig = {
    ...base,
    ...(isRecord(override["lmstudio"]) ? { lmstudio: { ...base.lmstudio, ...override["lmstudio"] } } : {}),
    ...(isRecord(override["code"]) ? { code: { ...base.code, ...override["code"] } } : {}),
    ...(isRecord(override["data"]) ? { data: { ...base.data, ...override["data"] } } : {}),
  }
  if (typeof override["cloudAgent"] === "string") merged.cloudAgent = override["cloudAgent"]
  if (typeof override["minSecretLength"] === "number") merged.minSecretLength = override["minSecretLength"]
  if (Array.isArray(override["localProviders"])) {
    merged.localProviders = override["localProviders"].filter((p): p is string => typeof p === "string")
  }
  if (Array.isArray(override["denylist"])) {
    merged.denylist = override["denylist"].filter((d): d is string => typeof d === "string")
  }
  return merged
}

export function parseConfigText(raw: string): MentatConfig {
  const parsed: unknown = JSON.parse(stripJsonComments(raw))
  return mergeConfig(DEFAULT_CONFIG, parsed)
}
