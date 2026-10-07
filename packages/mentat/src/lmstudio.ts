// LM Studio probe: "use any model the local API serves". Lists loaded models
// so `mentat_status` can confirm Layer 1 is up and show what it will use.

export interface LmStudioProbe {
  ok: boolean
  baseUrl: string
  models: string[]
  error?: string
}

export async function probeLmStudio(baseUrl: string, timeoutMs: number): Promise<LmStudioProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!response.ok) {
      return { ok: false, baseUrl, models: [], error: `HTTP ${response.status}` }
    }
    const body: unknown = await response.json()
    const data = (body as { data?: unknown }).data
    const models = Array.isArray(data)
      ? data
          .map((entry) => (entry as { id?: unknown }).id)
          .filter((id): id is string => typeof id === "string")
      : []
    return { ok: true, baseUrl, models }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint =
      message.includes("abort") || message.includes("ECONNREFUSED")
        ? " (is LM Studio running with the local server started on port 1234?)"
        : ""
    return { ok: false, baseUrl, models: [], error: `${message}${hint}` }
  } finally {
    clearTimeout(timer)
  }
}
