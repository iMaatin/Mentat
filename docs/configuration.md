# Configuration reference

Config is JSONC (comments allowed) at `.mentat/config.json`, merged over
built-in defaults. `~/.config/mentat/config.json` is consulted when no
project-level file exists. Secrets are never stored in config: the cloud layer
uses the provider variables already in your environment, and the local layer
needs no credential at all.

```jsonc
{
  "cloudModel": "anthropic/claude-sonnet-4-5",
  "cloudAgent": "build",
  "localModel": "qwen3-30b-a3b",
  "localBaseUrl": "http://127.0.0.1:1234/v1",
  "mockRows": 200,
  "seed": 20260101,
  "dataGlobs": [],
  "exclude": [],
  "sensitiveColumns": ["name", "email", "address", "phone", "ssn", "notes"]
}
```

`mentat init` writes this file with every default filled in and comments
explaining each key.

## Keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `cloudModel` | string | `anthropic/claude-sonnet-4-5` | Any model reference opencode accepts, e.g. `openrouter/…`. Override per run with `--model`. |
| `cloudAgent` | string | `build` | opencode agent. `build` allows edits; `plan` does not. |
| `localModel` | string | `qwen3-30b-a3b` | Must match a model loaded in LM Studio. Override with `--local` or `MENTAT_LOCAL_MODEL`. |
| `localBaseUrl` | string | `http://127.0.0.1:1234/v1` | Must be loopback. See the env section for the waiver. |
| `mockRows` | number | `200` | Synthetic rows per mocked table. Small on purpose: shape matters, size does not. Override with `--rows`. |
| `seed` | number | `20260101` | Mocks are seeded; the same input and seed always produce the same output. |
| `exclude` | string[] | `[]` | Extra names excluded from the mirror, beyond the built-in set (`node_modules`, `.git`, `dist`, `venv`, …). Matched by exact name. |
| `dataGlobs` | string[] | `[]` | Dataset paths to always mock even when outside the usual data directories. |
| `sensitiveColumns` | string[] | `name`, `full_name`, `first_name`, `last_name`, `email`, `address`, `phone`, `ssn`, `notes`, `comment`, `description`, `message` | Columns whose real values are replaced in generated data. Matched by whole-word containment (`email` covers `customer_email`); `"*"` matches every column. |
| `verbose` | boolean | `false` | Mirror every file in the log and stream cloud output live. |
| `autoApply` | boolean | `false` | Apply the restored patch without confirmation. |

## Environment variables

Environment variables override the config file.

| Variable | Overrides | Default |
| --- | --- | --- |
| `MENTAT_CLOUD_MODEL` | `cloudModel` | — |
| `MENTAT_LOCAL_MODEL` | `localModel` | — |
| `MENTAT_LOCAL_BASE_URL` | `localBaseUrl` | `http://127.0.0.1:1234/v1` |
| `MENTAT_LOCAL_API_KEY` | — | `lm-studio` |
| `MENTAT_LOCAL_TIMEOUT_MS` | — | `300000` |
| `MENTAT_OPENCODE_BIN` | — | auto-detected: `PATH` (PATHEXT-aware), desktop app locations, npm prefix |
| `MENTAT_PYTHON` | — | first of `python`, `python3`, `py` with pandas |
| `MENTAT_SIDECAR_TIMEOUT_MS` | — | `300000` |
| `MENTAT_SANDBOX_ROOT` | — | `%LOCALAPPDATA%/Mentat/sandboxes` (Windows), `~/.mentat/sandboxes` (elsewhere) |
| `MENTAT_CLOUD_EXTRA_ENV` | — | empty. Comma/semicolon-separated env var names forwarded to the cloud child beyond the built-in allowlist |
| `MENTAT_ALLOW_REMOTE_LOCAL` | — | unset. `1` waives the loopback requirement on layer 1 |
| `MENTAT_DEBUG` | — | unset. `1` enables plugin and CLI debug output |

## Where artifacts live

| Path | Contents |
| --- | --- |
| `.mentat/config.json` | This file. |
| `.mentat/jobs/<id>/prompt.txt` | Your original request, verbatim. |
| `.mentat/jobs/<id>/prompt.sanitized` | The de-identified request the cloud model received. |
| `.mentat/jobs/<id>/vault.json` | The identifier map (mode `0600`). Never shared, never committed. |
| `.mentat/jobs/<id>/result.patch` | Tokens restored, ready to apply. |
| `.mentat/jobs/<id>/report.json` | Status, token counts, egress scan, diff stat, errors. |
| `<sandbox base>/<id>/` | The synthetic mirror the cloud model edited. |
| `<job dir>/staging` | Full manifest with real paths. Never placed inside the sandbox. |

`mentat init` adds `.mentat/` to `.gitignore`. Running `ask` without it prints
a warning: `vault.json` is the exact inverse of the privacy guarantee and must
not be committed.
