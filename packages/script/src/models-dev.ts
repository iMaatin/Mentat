import path from "path"

/** Public catalog used by `bun run refresh:models` when neither override is set. */
export const DEFAULT_MODELS_DEV_URL = "https://models.dev"

/** Bundled catalog committed to this repository; see `snapshot/README.md`. */
export const snapshotPath = path.resolve(import.meta.dir, "../snapshot/models.dev.json")

/**
 * Build-time models.dev catalog injected as the `OPENCODE_MODELS_DEV` define.
 *
 * The build is offline-first so it never depends on infrastructure this project
 * does not control. Resolution order:
 *
 * 1. `MODELS_DEV_API_JSON` - read an explicit local `api.json`
 * 2. `OPENCODE_MODELS_URL` - opt in to fetching `<url>/api.json`
 * 3. the bundled snapshot, refreshed with `bun run refresh:models`
 */
export async function loadModelsDevData() {
  const local = process.env.MODELS_DEV_API_JSON
  if (local) {
    console.log(`opencode models.dev: reading local catalog from ${local}`)
    return Bun.file(local).text()
  }

  const url = process.env.OPENCODE_MODELS_URL
  if (url) {
    console.log(`opencode models.dev: fetching catalog from ${url}/api.json`)
    const response = await fetch(`${url}/api.json`)
    if (!response.ok) throw new Error(`Failed to fetch ${url}/api.json: ${response.status} ${response.statusText}`)
    return response.text()
  }

  const snapshot = Bun.file(snapshotPath)
  console.log(`opencode models.dev: using bundled catalog (${snapshot.size} bytes), refresh with "bun run refresh:models"`)
  return snapshot.text()
}
