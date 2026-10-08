# Bundled models.dev catalog

`models.dev.json` is a minified snapshot of the models.dev catalog in the exact
shape `https://models.dev/api.json` serves: a map of provider id to provider
record with nested models, pricing, limits, and modalities.

Builds read it through `loadModelsDevData` in `../src/models-dev.ts` and inject it
as the `OPENCODE_MODELS_DEV` define, which the runtime uses as its catalog floor
when no fetched cache exists yet. Keeping the catalog in the repository means
`bun install` and `bun run build` never require access to opencode.ai, models.dev,
or any other host this project does not control.

## Refresh

```bash
bun run refresh:models
```

The script fetches `${OPENCODE_MODELS_URL:-https://models.dev}/api.json` (or copies
`MODELS_DEV_API_JSON` when set), validates that the payload still contains at least
100 providers, and rewrites this file. Builds can also skip the snapshot without
rewriting anything:

- `MODELS_DEV_API_JSON=/path/to/api.json` reads a local catalog
- `OPENCODE_MODELS_URL=https://models.dev` fetches at build time

## Provenance

The committed snapshot was generated from
`https://models.opencode.ai/api.json` by the upstream `models-snapshot` job that
refreshes `anomalyco/opencode@v2:packages/core/src/models-dev/snapshot.txt`
(commit `a19285d`, 2026-10-07): 226 providers, 8418 models.
