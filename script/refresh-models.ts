#!/usr/bin/env bun

import { DEFAULT_MODELS_DEV_URL, snapshotPath } from "@opencode-ai/script/models-dev"

const local = process.env.MODELS_DEV_API_JSON
const url = process.env.OPENCODE_MODELS_URL ?? DEFAULT_MODELS_DEV_URL

const download = async () => {
  if (local) {
    console.log(`reading catalog from ${local}`)
    return Bun.file(local).text()
  }

  const response = await fetch(`${url}/api.json`)
  if (!response.ok) {
    console.error(`failed to fetch ${url}/api.json: ${response.status} ${response.statusText}`)
    process.exit(1)
  }
  return response.text()
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const modelCount = (provider: unknown) => {
  const models = isRecord(provider) && isRecord(provider.models) ? provider.models : undefined
  return models ? Object.keys(models).length : 0
}

const text = await download()
const parsed: unknown = JSON.parse(text)

// Guard against writing an error page or truncated body over the snapshot.
const providers = isRecord(parsed) ? Object.entries(parsed) : []
if (providers.length < 100) {
  console.error(`catalog has ${providers.length} providers, refusing to replace ${snapshotPath}`)
  process.exit(1)
}

await Bun.write(snapshotPath, JSON.stringify(parsed))
console.log(`wrote ${providers.length} providers / ${providers.reduce((count, [, provider]) => count + modelCount(provider), 0)} models to ${snapshotPath}`)
