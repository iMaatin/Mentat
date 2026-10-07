# Mentat — two-layer private agentic coding

Mentat splits coding work across two layers so **your real code and data never leave your machine**:

1. **Layer 1 — local gatekeeper (LM Studio, any model it serves).** Owns the real prompt, repo, and data. Builds a sanitized **mock bundle**: look-alike code (identifiers renamed, secrets redacted, structure intact) + a **small** look-alike dataset (same columns/dtypes, same joint missingness pattern, fake values).
2. **Egress gate (deterministic, fail-closed).** Scans the exact outbound bytes for any proprietary identifier. Any hit blocks — nothing is sent anywhere.
3. **Layer 2 — cloud worker (any vendor: OpenAI, Anthropic, Gemini, DeepSeek, …).** A tool-less subagent that only sees the mock bundle and returns a mock-space diff + notes.
4. **Layer 1 unpacker.** Translates the answer back to real identifiers/paths, verifies no mock tokens survive, and the local agent applies + tests.

```
real prompt + repo + data ──▶ [Layer 1: prepare + gate] ──▶ mock bundle ──▶ [Layer 2 cloud] ──▶ mock diff ──▶ [Layer 1: reintegrate + apply]
                                        │                                                                                  ▲
                                        └──── vault (.mentat/, local only) ────────────────────────────────────────────────┘
```

## Quickstart

1. **LM Studio**: load any model (e.g. Qwen3 27B), start the local server (port `1234`, OpenAI-compatible).
2. **Providers** (`opencode.json`): add the `lmstudio` custom provider and your cloud vendor(s). Snippets in [`docs/CONFIG.md`](docs/CONFIG.md).
3. **Cloud worker model**: set `model:` in [`.opencode/agent/mentat-cloud.md`](../../.opencode/agent/mentat-cloud.md) to your cloud coder (or override via `opencode.json` → `agent`).
4. **Policy (optional)**: copy [`mentat.example.json`](mentat.example.json) to `mentat.json` in your project and tune (column policy, budgets, denylist).
5. In opencode: switch to your `lmstudio/*` model (`/models`), optionally switch agent to `mentat` (Tab), then:
   - `/mentat <your task>` — full two-layer flow, or
   - `mentat_status` — verify Layer 1 is up.

## What's where

- `src/` — `@mentat/core`: pure deterministic core (vault, scanner, CSV profiler/synthesizer, code skeletonizer, bundle builder, reintegrator, audit, LM Studio probe). No network, no LLM calls. 37 tests.
- `test/` — `node:test` suites + fixtures (run: `node --test test/*.test.ts` with type-stripping Node, or `bun test`).
- `docs/THREAT_MODEL.md` — what "never leaves" covers, guarantees, and residual risks. **Read this.**
- `docs/CONFIG.md` — LM Studio + cloud vendor setup, per-project policy.
- `mentat.example.json` — annotated policy template.
- Plugin wiring: [`.opencode/plugins/mentat.ts`](../../.opencode/plugins/mentat.ts) (tools `mentat_status` / `mentat_prepare` / `mentat_reintegrate` + two egress hooks).
- Agents: [`.opencode/agent/mentat.md`](../../.opencode/agent/mentat.md) (local primary), [`mentat-cloud.md`](../../.opencode/agent/mentat-cloud.md) (cloud subagent, zero tools).
- Command: [`.opencode/command/mentat.md`](../../.opencode/command/mentat.md) (`/mentat`).

## The privacy boundary in one paragraph

Only three things may cross to the cloud: the sanitized task, mock code, and mock data — all scanned at three chokepoints (prepare gate, `task→mentat-cloud` hook, any-message-to-cloud hook) against the vault of known proprietary terms plus secret/entropy patterns. The vault, real files, and audit log live under `.mentat/` (gitignored). See `docs/THREAT_MODEL.md` for the honest residual risks (unknown proprietary prose, metadata like row counts, untrusted cloud output).
