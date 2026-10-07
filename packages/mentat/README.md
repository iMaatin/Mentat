# Mentat core — two-layer private agentic coding

Mentat separates coding work into two layers:

1. **Local gatekeeper (LM Studio or another trusted local provider):** owns the real prompt, repository, and data. It creates a sanitized mock bundle with renamed identifiers, redacted secrets, and synthetic CSV values.
2. **Fail-closed egress gate:** scans the exact outbound text against the local vault and secret patterns. A hit blocks the request.
3. **Cloud worker:** a provider-agnostic, tool-less subagent that sees only the mock bundle and returns a mock-space diff.
4. **Local reintegration:** maps the answer back to real identifiers and paths for human review and testing.

The implementation details and residual risks are in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). In particular, no sanitizer can detect every unknown proprietary phrase or hide all metadata.

## Quickstart

1. Start LM Studio's OpenAI-compatible local server (default port `1234`) with a model loaded.
2. Configure the LM Studio provider and one cloud provider in `opencode.json`; examples are in [`docs/CONFIG.md`](docs/CONFIG.md).
3. Point the `mentat-cloud` agent at your cloud model in [`.opencode/agent/mentat-cloud.md`](../../.opencode/agent/mentat-cloud.md) or override it in `opencode.json`.
4. In OpenCode, select your `lmstudio/*` model with `/models`, then switch to the `mentat` agent if needed.
5. Ask the local Mentat agent to **run `mentat_status`** and report whether Layer 1 is ready; `mentat_status` is an agent tool, not a TUI command. Then run `/mentat <your task>`.
6. Optionally copy [`mentat.example.json`](mentat.example.json) to `mentat.json` in your project and tune its column policy, budgets, and denylist.

## Package and plugin map

- `src/` — `@mentat/core`: deterministic vault, leak scanner, CSV profiler/synthesizer, code skeletonizer, bundle builder, reintegrator, audit log, and LM Studio probe. Core code makes no network or LLM calls.
- `test/` — unit tests with synthetic fixtures. Run `bun test test/*.test.ts` from this directory (or `bun run --cwd packages/mentat test` from the repository root).
- [`docs/CONFIG.md`](docs/CONFIG.md) — local and cloud provider setup plus project policy.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — security properties, limits, and operator checklist.
- [`docs/BRANDING.md`](docs/BRANDING.md) — v0 naming and compatibility decision.
- Plugin wiring: [`.opencode/plugins/mentat.ts`](../../.opencode/plugins/mentat.ts) (`mentat_status`, `mentat_prepare`, `mentat_reintegrate`, and egress hooks).
- Agents: [`.opencode/agent/mentat.md`](../../.opencode/agent/mentat.md) (local gatekeeper) and [`.opencode/agent/mentat-cloud.md`](../../.opencode/agent/mentat-cloud.md) (tool-less cloud worker).
- Command: [`.opencode/command/mentat.md`](../../.opencode/command/mentat.md) (`/mentat`).

## Copying the plugin to another project

Keep the complete `packages/mentat/` directory at the repository root next to `.opencode/`. The plugin's relative import expects `../../packages/mentat/src/index.js` from `.opencode/plugins/mentat.ts`; copying only the plugin file will break that import. The required layout is documented in the [top-level README](../../README.md). A live local-model plus cloud-vendor integration has not yet been verified.
