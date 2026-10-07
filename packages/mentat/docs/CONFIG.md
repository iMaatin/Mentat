# Mentat configuration

## 1. LM Studio (Layer 1 — local)

1. Open LM Studio → load any model (e.g. Qwen3 27B — Mentat uses **whatever the local API serves**, the model ID is never hardcoded).
2. Local Server tab → Start Server (default `http://127.0.0.1:1234/v1`, OpenAI-compatible).
3. Verify: `curl http://127.0.0.1:1234/v1/models`
4. Register it in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio (local)",
      "options": { "baseURL": "http://127.0.0.1:1234/v1" },
      "models": {
        "local": { "name": "LM Studio (whatever is loaded)" }
      }
    }
  }
}
```

Then `/models` → pick `lmstudio/local`, or set `"model": "lmstudio/local"` globally.
Run `mentat_status` (Mentat tool) to confirm reachability + loaded models.

> Any OpenAI-compatible local server works (Ollama, llama.cpp, vLLM, MLX): add its provider ID to `localProviders` in `mentat.json` so the egress guard treats it as local.

## 2. Cloud vendor (Layer 2)

Layer 2 is provider-agnostic. Connect your vendor(s) once (`/connect`), then point the cloud worker at one in [`.opencode/agent/mentat-cloud.md`](../../../.opencode/agent/mentat-cloud.md) (`model:`), or override in `opencode.json`:

```json
{
  "agent": {
    "mentat-cloud": { "model": "anthropic/claude-sonnet-4-5" }
  }
}
```

Vendor examples (`providerID/modelID`):

| Vendor | Example model value |
|---|---|
| OpenAI | `openai/gpt-5-mini` (default in template) |
| Anthropic | `anthropic/claude-sonnet-4-5` |
| Google | `google/gemini-2.5-flash` |
| DeepSeek (OpenAI-compatible) | `deepseek/deepseek-chat` |

Switch vendors per task by editing that one line — bundles are vendor-neutral.

## 3. Project policy (`mentat.json`)

Copy [`mentat.example.json`](../mentat.example.json) to `mentat.json` (project root) or `.opencode/mentat.json`. Highlights:

- `data.columnPolicy`: `keep` (faithful schema words) / `alias` (renamed, auto-mapped back — **recommended**) / `hash` (`col_<hex>`, opaque).
- `code.strings` / `code.comments`: `keep` / `redact-secrets` / `elide`. URLs/hosts/emails/private IPs normalize under every policy except `elide` (which removes them).
- `denylist`: project codenames, client names, internal hosts — always treated as secrets.
- `data.includeRealCounts`: set `false` if even table sizes are sensitive.
- `localProviders`: provider IDs allowed to see real content. **Never add a cloud provider here.**

## 4. Sanity checklist

- [ ] `mentat_status` shows LM Studio UP with your loaded model.
- [ ] Session model is `lmstudio/*` before real work.
- [ ] `mentat-cloud` agent has `tools: {"*": false}` intact.
- [ ] `.mentat/` stays untracked (`git status` clean of it).
