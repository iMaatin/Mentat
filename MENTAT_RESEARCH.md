# Mentat — Two-Layer Private Agentic Coding Platform: Research & Recommendation

> Goal: Layer 1 (local model on LM Studio) owns the real prompt + codebase + data, then emits a
> sanitized prompt + look-alike mock code + small mock data (no proprietary info / identifiers) to
> Layer 2 (big cloud model). Layer 2 returns code/instructions against the mock; Layer 1 unpacks and
> re-adapts them to the real codebase. Real code/data must never leave the machine.

Date: 2026-10-07. Repo: this checkout (`iMaatin/Mentat`, branched from `opencode` `dev`).

---

## 1. What this repo already is (important)

This repo **is already an agentic coding harness** — it's a fork of OpenCode ("The open source AI
coding agent"), a provider-agnostic agent loop (LLM → tool execution → response, `finish_reason`-driven)
with client/server + TUI architecture, permission system, MCP/LSP support, and 75+ providers via AI SDK
+ Models.dev. Key facts verified in-tree:

- **LM Studio is already a first-class custom provider**: `packages/web/src/content/docs/providers.mdx`
  documents `lmstudio` via `@ai-sdk/openai-compatible` with `baseURL: http://127.0.0.1:1234/v1`.
  LM Studio's server is OpenAI-compatible (`/v1/chat/completions`, `/v1/models`) on port 1234 by default.
- **A real plugin system with ~20 hook points** exists in `packages/plugin/src/index.ts` (`Hooks` interface):
  `chat.message`, `chat.params`, `experimental.chat.messages.transform`,
  `experimental.chat.system.transform`, `tool.execute.before/after`, `permission.ask`, `event`, `tool`,
  `auth`, `provider`, plus tool-output bounding/MCP plumbing in `packages/opencode/src/`.
- **Multi-agent orchestration via plugin is proven**: the ecosystem already does model-routing /
  subagent plugins (e.g. oh-my-opencode-slim style: route jobs to specialized subagents).
- House conventions: `AGENTS.md`, `CONTEXT.md` (System Context algebra, Context Epoch, durable inbox).

So "build a new agentic app" would mean **re-implementing what this repo already contains**.

---

## 2. Options evaluated

### Option A — Brand-new standalone agentic app (from scratch)
Build your own loop, tools, TUI/CLI, provider adapters, permissions, compaction, MCP, etc.
- Pros: total control; you can architect the no-egress guarantee from day one (separate processes,
  firewall the cloud worker's filesystem/network).
- Cons: enormous cost — months to reach parity with any existing harness; you re-solve streaming,
  tool-calling quirks per provider, truncation/compaction, IDE/TUI, auth, updates. Highest risk of
  stalling. Only justified if existing harnesses fundamentally cannot host the privacy boundary.

### Option B — Build Mentat as an OpenCode plugin + thin fork conventions (this repo) ⭐
Implement the two-layer system **inside this codebase**: a first-party `mentat` plugin
(`.opencode/plugins/` → later `packages/mentat/`) plus config/agents, using the local LM Studio
provider as Layer 1 and any cloud provider as Layer 2.
- Pros:
  - **Fastest to working**: agent loop, tools, permissions, TUI, LM Studio provider, model picker all exist.
  - **Right seams**: `chat.message` / `messages.transform` / `system.transform` can carry only the mock
    bundle to the cloud model; `tool.execute.before/after` + `permission.ask` can deny the cloud agent
    any access to real paths and redact tool output; `event(session.idle)` can drive the
    sanitize → send → reintegrate pipeline.
  - **Provider-agnostic Layer 2**: swap OpenAI/Anthropic/Gemini/DeepSeek/etc. per task without rewriting.
  - **Open source (MIT), forkable**: this repo *is* the fork; upstream updates can still be merged.
  - Plugin architecture is TypeScript-first with typed tools, hooks pipeline, shell API, and precedent
    for 25+-agent orchestration plugins. [1](https://lobehub.com/skills/pantheon-org-opencode-plugins-opencode-plugin-development) [2](https://www.blog.brightcoding.dev/2026/07/19/awesome-opencodeawesome-opencode-the-essential-plugin-registry-for-ai-coding-agents) [3](https://gist.github.com/shibuiwilliam/1d1466b24cb5c8f0d9367f2c75c9c064)
- Cons / must-handle:
  - The no-leak guarantee becomes **hook discipline + auditing** rather than a physical airgap: every path
    that could exfiltrate (message transforms, tool outputs, compaction summaries, share/sync features,
    MCP servers, shell env) must be allowlisted/redacted for the cloud session. Needs a strict test suite
    ("red-team" fixtures asserting real tokens never appear in cloud-bound payloads).
  - Must disable/bypass features that phone home for cloud sessions (share, console sync, etc.).

### Option C — Claude Code plugin / hooks
Claude Code has the deepest proprietary-harness extensibility: 26 lifecycle hook events
(PreToolUse/PostToolUse), skills, plugins, subagents, Agent SDK. [3](https://www.firecrawl.dev/blog/claude-code-vs-codex) [5](https://mem0.ai/library/coding-agents/openai-codex-vs-claude-code-which-ai-coding-agent-wins-in-2026)
- Pros: mature hooks for redaction/validation; good terminal UX; Agent Teams for multi-agent.
- Cons (decisive for Mentat): **cloud-first, Anthropic-centric** — local-model support is limited to select
  surfaces/third-party providers [4](https://www.ayautomate.com/blog/codex-vs-claude-code); you don't control the
  harness source the way you do here, so a "never leaves the machine" guarantee rests on someone else's
  client; vendor lock-in for the orchestration layer. Good as a *Layer-2 model choice*, bad as the *home* for Mentat.

### Option D — Codex CLI extension
Codex CLI is open source (Apache 2.0) with kernel-level sandboxing (Seatbelt/Landlock/seccomp) — the
strongest *execution* sandbox story. [2](https://www.nxcode.io/resources/news/claude-code-vs-codex-cli-terminal-coding-comparison-2026)
- Pros: strong sandbox; open source; ChatGPT-subscription-friendly.
- Cons (decisive): **extensibility is the weakest** — MCP + AGENTS.md + approval modes, "nothing equivalent
  to the hook/plugin/agent ecosystem," no hooks equivalent. [1](https://github.com/anipotts/claude-code-tips/blob/main/docs/comparisons/codex.md) [3](https://www.firecrawl.dev/blog/claude-code-vs-codex)
  Building the sanitizer/reintegrator there means fighting the harness instead of using it.

### Option E — Harness-independent sanitizing proxy / gateway (standalone sidecar)
A local service that sits between *any* harness and the cloud API: intercepts chat-completions traffic,
replaces real→mock on egress, mock→real on ingress.
- Pros: works with Codex/Claude/OpenCode without forking any of them; single chokepoint; can be combined
  with B for defense-in-depth.
- Cons: brittle outside the harness — it sees HTTP payloads, not tool/file semantics; mapping patches back
  correctly without agent cooperation is hard; each harness needs baseURL rewiring and behavior quirks.
  Best as a **second wall**, not the primary design.

### Note on "DeepSeek harness"
There is no DeepSeek agent harness with a plugin ecosystem comparable to the above; DeepSeek is a
*model/API provider*. The right role for DeepSeek in Mentat is as a **Layer-2 cloud model option**
(OpenCode already supports DeepSeek-style OpenAI-compatible endpoints), not as the base to build on.

---

## 3. Comparison matrix

| Dimension | A: New app | B: OpenCode plugin/fork ⭐ | C: Claude Code | D: Codex CLI | E: Standalone proxy |
|---|---|---|---|---|---|
| Time to working Mentat | Months | Days–weeks | Weeks | Weeks+ (fighting gaps) | Weeks (brittle) |
| No-leak enforceability | Strongest (airgap-able) | Strong w/ hook discipline + tests | Medium (client you don't own) | Weak (no hooks) | Medium (HTTP-only view) |
| Local LM Studio Layer 1 | You build it | Already supported (1234/v1) | Limited / third-party only | Not native | Agnostic but dumb |
| Layer-2 model choice | You build adapters | 75+ providers incl. DeepSeek-class | Anthropic-centric | OpenAI-centric | Any OpenAI-compat |
| Tool/file-aware mocking | Full control, from zero | Full via hooks + tools | Good hooks, foreign client | Poor | None (payload-only) |
| Maintenance burden | You own everything | Merge upstream + own plugin | Track vendor API | Track vendor API | Track N harnesses |

---

## 4. Recommendation

**Option B: build Mentat as a first-party plugin + conventions in this repo (OpenCode fork).**

Reasoning in one paragraph: the privacy boundary you want is *semantic* (understand real code/data →
synthesize faithful-but-fake look-alikes → map cloud patches back), not just a regex firewall. That needs
deep hooks into the agent loop, tools, and filesystem — exactly what this repo's plugin system exposes —
plus native LM Studio support for the local gatekeeper and 75+ providers for the cloud worker. Options C/D
give you less control where it matters most (the egress path), option A burns months re-creating this repo,
and option E can't see enough to do faithful mock↔real mapping. Build B first; add E later as a second wall
if you want belt-and-suspenders.

### Proposed Mentat architecture (to be refined after your answers)

```
┌─ YOUR MACHINE ─────────────────────────────────────────────────────┐
│                                                                    │
│  Real prompt + real repo + real data                               │
│        │                                                           │
│        ▼                                                           │
│  ┌─────────────┐   owns fs/tools   ┌──────────────────────────┐    │
│  │ LAYER 1     │ ─────────────────▶│ Identifier vault (local) │    │
│  │ Gatekeeper  │  real→mock map    │ real⇄mock names/values    │    │
│  │ (LM Studio  │                   └──────────────────────────┘    │
│  │  local LLM) │                                                   │
│  └─────┬───────┘                                                   │
│        │ sanitized prompt + mock repo slice + small mock data      │
│        ▼                                                           │
│  ┌─────────────┐  deterministic scanners (AST/regex/entropy,       │
│  │ EGRESS GATE │  gitleaks-style, token budget, allowlist paths)   │
│  └─────┬───────┘  ❌ blocks on any real identifier leak             │
│        │ ✅ mock bundle only                                       │
│        ════════════════════════════════════════                    │
│        │ INTERNET (mock bundle only)              ║                 │
└────────│──────────────────────────────────────────║─────────────────┘
         ▼                                          ║
  ┌─────────────┐  no tools on real fs              ║
  │ LAYER 2     │  patch/plan against MOCK only     ║
  │ Cloud coder │───────────────────────────────────╝
  │ (any vendor)│  returns unified diff / instructions
  └─────────────┘
         │ (mock-space patch)
         ▼ back inside the machine
  ┌─────────────┐  vault maps mock→real, validates,
  │ REINTEGRATOR│  applies, runs local tests (Layer 1 LLM + deterministic)
  │ (local)     │
  └─────────────┘
```

Mock-fidelity strategy (your dataset example):
- **Profiler (deterministic, local)**: per-column dtype, null/missingness %, cardinality, min/max,
  distributions, FK-ish relations; per-file AST skeleton (signatures, control flow, imports).
- **Synthesizer (local LLM + Faker-style generators)**: same column names *or* deterministic aliases
  (3 modes: keep names / alias / hash — your call per project), same dtypes + same missingness pattern,
  same shape of code (renamed identifiers, stubbed bodies), but **N small** (e.g. 20–200 rows) to save tokens.
- **Vault**: the only place real⇄mock mapping lives; never serialized into cloud-bound payloads; audit log
  of every egress payload with leak-scan verdict.

### What we'd build first (thin end-to-end slice)
1. `mentat` plugin skeleton: `sanitize` (Layer 1) → `cloud-ask` (Layer 2, tools denied, mock workspace only)
   → `reintegrate` (Layer 1) commands/tools + session wiring.
2. LM Studio + one cloud provider configured; model routing (gatekeeper=local, worker=cloud).
3. Deterministic leak scanner + egress audit log + red-team fixture tests.
4. Tabular mock-data profiler/synthesizer (your missingness-pattern requirement) + code skeletonizer v0.
5. Docs: threat model ("what 'never leaves' covers and doesn't"), per-project aliasing policy.

---

## 5. Open questions for you (asked in chat)

1. Implementation path: B (recommended) vs A / E / spike-first?
2. Layer-2 vendor(s): OpenAI / Anthropic / Gemini / DeepSeek / other?
3. Local hardware + preferred LM Studio model (drives gatekeeper prompt design)?
4. Data scope v0: tabular (pandas/CSV/SQL) + which languages? Column-name policy (keep/alias/hash)?

## 6. Decision (2026-10-07)

- **Path: B** — build Mentat as a first-party plugin + conventions in this repo (OpenCode fork).
- **Layer 2: provider-agnostic** — `mentat-cloud` subagent model is one-line switchable per vendor.
- **Layer 1: any model LM Studio serves** (user runs Qwen3 27B; nothing hardcodes a model ID — `mentat_status` probes `/v1/models`).
- **v0 scope: both** — code anonymization + tabular mock data in the first slice.

Implemented: `packages/mentat/` (`@mentat/core`: vault, scanner, CSV profiler/synthesizer with joint-missingness preservation, code skeletonizer, bundle builder + fail-closed gate, reintegrator, audit, LM Studio probe; 37 tests), `.opencode/plugins/mentat.ts` (tools `mentat_status`/`mentat_prepare`/`mentat_reintegrate` + `task→mentat-cloud` and any-message-to-cloud egress hooks), `.opencode/agent/mentat.md` + `mentat-cloud.md`, `.opencode/command/mentat.md` (`/mentat`), `docs/THREAT_MODEL.md` + `docs/CONFIG.md`, `mentat.example.json`. Repo resynced to upstream `dev` (ecc4916b5) before commit.
