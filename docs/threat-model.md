# Threat model

> This document states *what is assumed* and *what can still leak*. For the
> mechanism behind each boundary, see [architecture.md](architecture.md); for
> every tunable, see [configuration.md](configuration.md).

## Trust boundaries

Mentat assumes exactly one untrusted party: **the cloud model provider** (and
transitively, whoever operates the opencode endpoint you point it at). Your
machine, your local model, and the Python sidecar are trusted. The sandbox is
trusted as *code* — it is your own code with names swapped — but its contents
are by construction things the provider is allowed to see.

```
  your machine (trusted)              │  network
                                      │
  prompt ──▶ local model (127.0.0.1)  │
             │                        │
             ▼                        │
           vault ──▶ sandbox ────────▶│──▶ cloud model
                      ▲               │      │
                      │               │      ▼
                      └───────────────│─── diff (tokens restored locally)
```

## What crosses the boundary

Exactly two things:

1. **The prompt.** Your request, rewritten in de-identified terms by the local
   model, then scanned by the egress gate immediately before the spawn.
2. **The sandbox tree.** The synthetic mirror. The cloud agent reads it through
   opencode's tools with the sandbox as its working directory.

Nothing else leaves. Specifically:

- The real repository is never read by the cloud layer. The sandbox lives
  outside it and Mentat refuses to build one inside the tree it mirrors, so
  walking up from the sandbox does not reach the real files.
- `vault.json` (the token→real map), `prompt.txt`, and the job directory are
  guarded by `assertNotExfiltrated`, which runs on every outbound payload in
  addition to the content scanner.
- Secret files never enter the sandbox: `.env`/`.env.*`, `*.pem`, `*.key`,
  `*.p12`/`*.pfx`, `id_rsa*`, `.npmrc`, `.netrc`, `.htpasswd`, `credentials`
  data files, and the `.aws/`, `.ssh/`, `.gnupg/` directories are omitted and
  recorded as omissions. Their `KEY=value` contents are not identifiers, so
  tokenization could not have protected them; omission is the only safe
  treatment.
- Datasets are never copied either — only synthetic rows generated from
  statistical profiles, with identifying columns replaced by reserved-fiction
  values (RFC 2606 / RFC 5737 namespaces).

## The cloud child's environment

The cloud child does **not** inherit `process.env`. A headless agent has shell
tools inside the sandbox; a full environment passthrough would let `env`
exfiltrate every secret on the machine — AWS keys, GitHub tokens, corporate
SSO — with the next tool call. The child receives an allowlist:

| Category | Variables |
| --- | --- |
| Process basics | `PATH`, `PATHEXT`, `COMSPEC`, `SystemRoot`, `WINDIR` |
| Filesystem | `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA` |
| Locale/time | `LANG`, `LC_ALL`, `TZ` |
| Provider credentials | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `COHERE_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `PERPLEXITY_API_KEY`, `MOONSHOT_API_KEY`, `AZURE_OPENAI_*`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, … |
| Explicit extras | whatever `MENTAT_CLOUD_EXTRA_ENV` names, comma-separated |

Provider keys are on the list deliberately: layer 2 cannot authenticate
without them. The trade is explicit — the cloud provider whose key you use
already trusts you with that key; everything else in your environment is none
of their business, and stays here.

## The egress gate

Two checks, run in order, immediately before the spawn. Both **fail closed**:

1. `assertNotExfiltrated` — payload must not reference local-only artifact
   paths. Patterns are anchored to path starts.
2. `assertClean` — every vault literal plus ~20 structural rules: AWS-style
   keys, PEM private-key blocks, API keys, GitHub/Slack tokens, JWTs,
   connection-string credentials, private IPv4, internal hostnames, live
   emails, Luhn-validated card numbers, US SSNs, user-specific absolute paths.

A finding aborts the run. It is never reduced to a log line. The same
deterministic rules run in the OpenCode plugin as an outbound guard, so opening
`opencode` directly in a Mentat project is covered too.

Gate 2 (the content scan) makes one exception, and only for Gate 2: when the
scan finds something, the CLI shows the findings — rule, severity, count, a
masked excerpt — and offers the operator an explicit `[y/N]` override (or
`--allow-egress` for non-interactive use). This exists because the vault is
sometimes deliberately incomplete and a handful of acceptable leaks are a
real-world case. The decision is recorded, not laundered: the findings stay on
the run and `report.json` is stamped `egressApproved: true` beside them. Without
a TTY and without `--allow-egress`, the run stays fail-closed. Gate 1
(`assertNotExfiltrated`) has no override at all — a reference to the vault or
the job directory is always a bug.

## Layer 1 is pinned to loopback

A remote layer 1 would upload your prompt and code *before* any redaction ran,
defeating the entire design. `assertLocalEndpoint` refuses non-loopback
`MENTAT_LOCAL_BASE_URL` unless `MENTAT_ALLOW_REMOTE_LOCAL=1` is set
deliberately, requests use `redirect: "error"` so a 3xx cannot carry the
payload off-machine, and the timeout covers the whole exchange including the
body.

## Residual risks, stated plainly

- **The provider sees what the mirror contains.** Tokens are structurally
  neutral and file layout is preserved, so the shape of your system is visible
  by design — that is what makes the cloud model useful. If the *shape itself*
  is confidential, do not use a cloud layer.
- **A proprietary term the vault has never seen** cannot be caught by the
  vault-literal scan. Structural rules and the local model's term extraction
  both compensate, but neither is a proof. `mentat scan` lets you check any
  file against the latest vault before sending.
- **`%VAR%` in prompt text** may be expanded by `cmd.exe` on Windows when the
  opencode binary is an npm `.cmd` shim. Point `MENTAT_OPENCODE_BIN` at a real
  executable to remove that edge.
- **Comments are tokenized aggressively**, at the cost of occasionally turning
  a distinctive English word into a token. This direction is chosen on purpose:
  over-tokenization costs readability, under-tokenization costs the whole
  guarantee.
