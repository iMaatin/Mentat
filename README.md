# Mentat

[![CI](https://github.com/iMaatin/Mentat/actions/workflows/ci.yml/badge.svg)](https://github.com/iMaatin/Mentat/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A two-layer coding agent. Your code and data never leave your machine.

Mentat runs a local model first, which understands your request and your
repository, then builds a **synthetic mirror** of your project and hands *that* to
a large cloud model. The cloud model makes the change against the mirror. Mentat
maps the result back onto your real files with exact token substitution.

The cloud model never sees your repository. Not a redacted version of it, not a
summary of it — a different codebase with the same shape.

```
  you        ┌───────────────────────────── local, never networked ─────────┐
  ──────►    │  layer 1: LM Studio                                        │
  request    │    · understand the request                                │
             │    · extract your domain vocabulary                         │
             │    · profile every dataset                                  │
             │    · mint synthetic rows                                    │
             └───────────────────────────────┬─────────────────────────────┘
                                             │  vault (real → token)
                                             ▼
                                  sandbox (outside your repo)
                                  zq_fn_fn_001, data/zq_tbl_tbl_001.csv
                                             │
  ┌──────────────────────────────────────────┴──────────────►  cloud
  │  layer 2: opencode run, headless, against the sandbox only │
  │  ─────────────────── egress gate ──────────────────────────│
  └──────────────────────────────────────────────┬───────────────┘
                                             │  diff
                                             ▼
             layer 3: restore tokens  ──►  your real repository
```

## Why a sandbox, and not a sanitized prompt

The obvious design is "redact the prompt, then let the agent read your files".
That is not a privacy boundary. The agent's `read`, `grep`, and `glob` tools will
pull real bytes into the request no matter what you did to the prompt text.

So the cloud model runs in a disposable directory **outside** your repository, and
Mentat refuses to build a sandbox anywhere inside the tree it is mirroring. From
that working directory the real tree is not reachable at all. The guarantee is
structural rather than a promise about what the prompt contains.

## Install

Requirements: **Node 20.11+**, a local model in [LM Studio](https://lmstudio.ai),
and the [`opencode`](https://opencode.ai) CLI for the cloud layer. Parquet,
Excel, and SQLite additionally need `pip install pandas pyarrow openpyxl`; CSV,
TSV, JSON, and JSONL need nothing.

```bash
git clone https://github.com/iMaatin/Mentat.git
cd Mentat
npm install
npm run build

# link the CLI onto your PATH, or call it directly:
(cd packages/cli && npm link)     # then: mentat --help
node packages/cli/dist/src/main.js --help
```

Quick start:

```bash
mentat init      # writes .mentat/config.json and gitignores the job directory
mentat doctor    # checks LM Studio, the opencode binary, and dataset formats
mentat ask "add retry with backoff to the ingest job"
```

`npx mentat` works the same way once the package is published.

## Commands

| Command | What it does |
| --- | --- |
| `mentat ask "<request>"` | The full four-stage pipeline. |
| `mentat init` | Create `.mentat/config.json` and gitignore the job directory. |
| `mentat doctor` | Verify LM Studio, the opencode binary, and dataset formats. |
| `mentat mock <path>` | Profile a dataset and print a synthetic preview. No network. |
| `mentat inspect <job>` | Report, egress scan, and restored patch for a past job. |
| `mentat apply <job>` | Restore tokens and write a reviewed patch to your repo. |
| `mentat scan <path>` | Run the egress scanner over a file or directory. |
| `mentat list` / `clean` | Manage recorded jobs. |

Useful flags for `ask`: `--dry-run` (build the sandbox and stop, touches no
network), `--apply` (write the result), `--rows <n>`, `--model`, `--local`,
`--prose`, `--no-local`, `--verbose`, `--allow-egress` (approve egress findings
without an interactive prompt — see [The egress gate](#the-egress-gate)).

## Configuration

`.mentat/config.json` (JSONC — comments allowed). Everything has a working
default; you only ever override what differs on your machine.

| Key | Default | What it does |
| --- | --- | --- |
| `cloudModel` | `anthropic/claude-sonnet-4-5` | opencode model for layer 2, e.g. `anthropic/claude-sonnet-4-5`. |
| `cloudAgent` | `build` | opencode agent. `build` allows edits; `plan` does not. |
| `localModel` | `qwen3-30b-a3b` | Model name as loaded in LM Studio. |
| `localBaseUrl` | `http://127.0.0.1:1234/v1` | LM Studio endpoint. **Must be loopback.** |
| `mockRows` | `200` | Synthetic rows generated per mocked dataset. |
| `seed` | `20260101` | Seed for reproducible mocks. Same input, same mock. |
| `exclude` | `[]` | Extra names excluded from the mirror, beyond the built-in set. |
| `dataGlobs` | `[]` | Dataset paths to always mock, even outside data directories. |
| `sensitiveColumns` | `name`, `email`, `address`, `phone`, `ssn`, … | Columns whose values are replaced in generated data. `"*"` matches all. |
| `verbose` | `false` | Mirror every file and stream cloud output. |
| `autoApply` | `false` | Apply the restored patch without confirmation. |

`sensitiveColumns` matches by word containment, so `email` covers
`customer_email` and `billing_email_address`.

### Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `MENTAT_LOCAL_BASE_URL` | `http://127.0.0.1:1234/v1` | Overrides `localBaseUrl`. Must be loopback unless `MENTAT_ALLOW_REMOTE_LOCAL=1`. |
| `MENTAT_LOCAL_MODEL` | — | Overrides `localModel`. |
| `MENTAT_CLOUD_MODEL` | — | Overrides `cloudModel`. |
| `MENTAT_OPENCODE_BIN` | auto-detected | Path to the opencode executable. |
| `MENTAT_PYTHON` | `python`/`python3`/`py` | Interpreter with pandas, for parquet/xlsx/sqlite. |
| `MENTAT_SIDECAR_TIMEOUT_MS` | `300000` | Hard ceiling per Python sidecar invocation. |
| `MENTAT_SANDBOX_ROOT` | OS temp-adjacent default | Where sandboxes live. Never inside the repo. |
| `MENTAT_CLOUD_EXTRA_ENV` | — | Comma-separated env var names passed through to the cloud child, in addition to the built-in allowlist. |
| `MENTAT_ALLOW_REMOTE_LOCAL` | unset | Set to `1` to waive the loopback requirement on layer 1. Understand what that waives first. |
| `MENTAT_DEBUG` | unset | Set to `1` for plugin/CLI debug output. |

## How the mocks are built

`mentat mock` on a real dataset reports this and reproduces it:

```
acme_big: 2000 rows x 10 columns
  account_id    string  card=2000  med=9  [id]
  region    string  card=3  cats=3
  tenure_months    int  card=60  med=30
  churn_score    float  null=9.1%  card=803  med=0.49
  co-occurring null groups: churn_score+support_tier
```

The generator reproduces **shape**, not values:

- **Missingness, including its structure.** Per-column null rates are matched,
  and columns whose null masks co-occur are nulled *together*. That last part is
  what breaks naive mocks: independently nulling columns destroys the joint
  pattern, and any model trained or reasoned against the result gets the wrong
  answer.
- **Correlations** between numeric columns, via a Cholesky factor of the
  profile's correlation matrix. Sampling each column independently would flatten
  every relationship your data actually has.
- **Category vocabularies** for discrete columns, including a column that is
  constant in the source.
- **Distributions** for continuous columns, sampled by inverse transform against
  the observed quantiles, clamped to the observed range.
- **Fresh identifiers.** Identifier-like columns get newly minted keys, so a
  customer id from your table never appears in the mock.

Column names are preserved deliberately: they describe the problem, not the
business. Values that *are* identifying — anything matching `sensitiveColumns` —
are replaced with values from reserved namespaces: `example.com` for mail (RFC
2606), `555-01xx` for phone numbers, `203.0.113.0/24` for addresses (RFC 5737).

Seeded, so the same input always produces the same mock.

## What the cloud model receives

Real:

```python
"""AcmeCorp billing service. Handles the acme_billing_ledger.
   Contacts: billing-ops@acmecorp.com """
from dataclasses import dataclass

ACME_DB_HOST = "10.4.2.19"

def compute_acme_churn(rows):
    """Compute churn against the acme_billing_ledger."""
```

Sent:

```python
"""zq_org_org_001 billing service. Handles the zq_org_org_002.
   Contacts: user@example.com """
from dataclasses import dataclass

zq_key_key_001 = "192.0.2.1"

def zq_fn_fn_001(rows):
    """Compute churn against the zq_org_org_002."""
```

Identifiers in **comments** are tokenized exactly like identifiers in code, so a
proprietary name that only ever appears in a comment still enters the vault and
never reaches the mirror. Comments cannot affect the mirror's runtime behaviour,
so this is safe; string literals, which may hold real data values, are scrubbed
but not rewritten.

`dataclass`, `pandas`, `read_parquet`, `True`, and the rest of the standard and
third-party surface survive intact. That matters more than it sounds: tokenizing
`from dataclasses import dataclass` produces code that does not parse, and a mock
the cloud model cannot run is worse than no mock.

Filenames are tokenized too (`acme_billing.py` → `zq_mod_mod_001.py`), because a
filename identifies an organization as plainly as an identifier does. Standard
tooling names like `package.json` and `requirements.txt` are preserved, since
renaming those breaks the build.

**Secret files never enter the mirror at all.** `.env` and `.env.*`, `*.pem`,
`*.key`, `*.p12`/`*.pfx`, `id_rsa*`, `.npmrc`, `.netrc`, `.htpasswd`,
`credentials` (the data files, not `credentials.py`), and the `.aws/`, `.ssh/`,
`.gnupg/` directories are omitted and recorded in the job manifest with an
explicit reason. A `KEY=value` line is not an identifier, so tokenization could
not protect it; omission is the only treatment that does.

## The egress gate

Three checks run in order, and the third one is the only thing standing between
a payload and the network:

1. `assertNotExfiltrated` — the payload must not reference `.mentat/`,
   `vault.json`, `prompt.txt`, or a `sandbox/` path. Patterns are anchored to
   path starts, so a repository that happens to keep a real `sandbox/`
   directory is not blocked mid-word.
2. `assertClean` — every vault literal plus ~20 structural rules (credentials,
   private addresses, internal hosts, live emails, cards validated by Luhn).
3. Only then is a process spawned.

Before either gate, the rewritten prompt gets one **deterministic
`vault.sanitize` pass**. The local rewriter has no vault, so a real identifier it
echoed back would otherwise survive into the payload and trip Gate 2; replacing
every known real with its token here is what makes the common case pass cleanly.

Both gates **fail closed**. A finding aborts the run; it is never logged and
passed along. Gate 1 (local-only artifact references) is never overridable.

### Reviewing an egress finding

Gate 2 (the content scan) treats a finding as a **human decision, not a hard
stop**. When the scan finds something in the outbound payload, Mentat prints
exactly what it saw — rule, severity, count, and a masked excerpt — and asks:

```
! 1 finding(s) in the outbound payload — refusing to send unless you approve.
  critical  vault-literal x3
      …zq_billing… ledger → real name present…
      A real identifier survived tokenization; fix extraction before sending.

  Send anyway? [y/N]
```

- Interactive runs prompt `[y/N]`. Non-interactive runs (scripts, the plugin)
  stay fail-closed unless `--allow-egress` is passed.
- Approving is **not** laundering: the findings are kept, and `report.json`
  records `egressApproved: true` beside them, so the decision is auditable. If
  you judge only a handful of tokens leak and the risk is acceptable, this is
  the way to proceed to layer 2.
- Gate 1 still cannot be approved around. A reference to `vault.json` or the job
  directory is always a bug, never a judgement call.

Guard runs in both directions: the CLI gates the prompt, and the OpenCode plugin
gates every outbound request in a plain session so that opening `opencode`
directly in a Mentat project cannot quietly ship your files either.

## What leaves the machine (threat model)

Two things cross the network boundary, and nothing else:

1. **The prompt** — your request, rewritten in de-identified terms by the local
   model, scanned by the gate immediately before the spawn.
2. **The sandbox tree** — the synthetic mirror, read by the cloud model through
   opencode's tools from inside the sandbox directory.

What the cloud child **does not** inherit:

- **Your environment.** The child gets an allowlist, not `process.env`:
  `PATH`, `SystemRoot`, `TEMP`/`TMP`, `HOME`/`USERPROFILE`, `APPDATA`,
  `LANG`, and the provider API key variables opencode needs to authenticate
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …). AWS keys,
  GitHub tokens, corporate SSO material, and everything else stay here. Need a
  variable passed through? Name it explicitly with `MENTAT_CLOUD_EXTRA_ENV`.
- **Your filesystem.** The sandbox is outside the repository, and the
  repository path is not reachable by walking up from it.
- **Secret files.** They are omitted from the mirror before anything is built
  (see above).

What the cloud provider itself sees — your prompt text and the mirror — is
covered by your agreement with that provider. Mentat's job is to make sure that
is *all* they ever see.

## Layer 1 refuses to be remote

Layer 1 is pointed at `http://127.0.0.1:1234/v1` and verified to be loopback.
If `MENTAT_LOCAL_BASE_URL` is set to a remote address, Mentat refuses to start,
because a remote layer 1 would upload your prompt and code *before* any
redaction had run — defeating the entire design. Override with
`MENTAT_ALLOW_REMOTE_LOCAL=1` only if you understand what that waives. Requests
to the endpoint also use `redirect: "error"`: a loopback server that answers
with a 3xx is treated as unavailable rather than followed off-machine, and the
request timeout covers the whole exchange including the body.

Layer 1 does a small, specific set of things: rewrites your request in
de-identified terms, names the proprietary identifiers in your code, and
polishes comments. Everything statistical and structural is deterministic code,
because a language model cannot be relied on to reproduce a null-co-occurrence
pattern exactly, whereas a generator can.

## Layout

```
packages/
  core/      vault, sanitizer, scanner, profiler, mock generator, sandbox, patch
  local/     LM Studio client and the four layer-1 tasks
  cloud/     opencode driver, with the egress gate in front of the spawn
  cli/       argument parsing, config, pipeline
  oc-plugin/ /mentat command and the outbound guard
docs/        architecture, threat model, configuration reference
.mentat/     per-job artifacts; gitignored, never leaves the machine
```

Each job keeps your original prompt, the de-identified prompt, the vault, the
sandbox, the restored patch, and a report:

```
.mentat/jobs/20260101-142233-a7f/
  prompt.txt          prompt.sanitized     vault.json   (0600)
  result.patch        report.json          sandbox/
```

## OpenCode plugin

```jsonc
// opencode.jsonc
{
  "plugins": [{ "package": "./packages/oc-plugin", "options": { "guard": true } }]
}
```

Adds `/mentat <request>` and the outbound guard. It holds none of the privacy
logic; it delegates to the CLI. The guard is opt-out per project (`guard:
false`), and extra rules can be added with `extraRules`.

## Troubleshooting

**LM Studio / layer 1**

- `Cannot reach the local model` — is LM Studio running with its local server
  enabled (Developer tab)? The default endpoint is `http://127.0.0.1:1234/v1`.
- `configured localModel "..." is not loaded` — the name must match a loaded
  model exactly; check the Models tab, or run `mentat doctor` to list what the
  server reports. Set `MENTAT_LOCAL_MODEL` or pass `--local <name>`.
- The refusal to fall back to a cloud model for layer 1 is deliberate. Mentat
  will not silently send your prompt to a remote model because the local one is
  down.

**opencode / layer 2**

- `Could not find the opencode CLI` — install it, or set `MENTAT_OPENCODE_BIN`
  to its path. Mentat probes `PATH` (with `PATHEXT` on Windows, so npm's
  `opencode.cmd` shim is found), the OpenCode desktop app install locations,
  and the npm global prefix.
- **Windows:** `opencode.cmd` is a batch shim, and Node ≥ 20.12 refuses to
  spawn `.cmd` files directly (the CVE-2024-27980 mitigation). Mentat drives
  it through `cmd.exe /d /s /c` with an explicitly quoted command line — no
  `shell: true` anywhere. If your prompt text contains `%VAR%`-style
  references, cmd may expand them; point `MENTAT_OPENCODE_BIN` at a real
  executable to remove that edge entirely.
- `Cloud run exited 1` — the reason is in the job's `report.json` under
  `errors`. When opencode's stderr is empty, Mentat reports its `error` event
  instead, e.g. `provider.no-route: Model unavailable: anthropic/...` — a model
  id your opencode has no provider for. The next most common cause is
  authentication: the provider API key (e.g. `ANTHROPIC_API_KEY`) must be
  present in *your* environment — the cloud child receives exactly the
  allowlisted provider variables, nothing more.

**Python sidecar**

- `no python with pandas` — `pip install pandas pyarrow openpyxl`, or point
  `MENTAT_PYTHON` at an interpreter that has them. CSV/TSV/JSON/JSONL need no
  Python at all.
- `Python sidecar timed out` — a large or wedged read. Raise
  `MENTAT_SIDECAR_TIMEOUT_MS`; the process is killed and the run fails closed
  rather than hanging.

## Known limits

- Layer 3 applies hunks by matching context. When the real file diverges from
  the mock, some hunks will not apply. They are reported per file and the
  sandbox is kept so you can reconcile by hand. Nothing is forced.
- `applyHunks` does not re-parse the target language, so a hunk inside a
  construct with unusual formatting can fail to match.
- Column *values* in small vocabularies are reproduced. If a `region` column
  contained a customer name, add it to `sensitiveColumns`.
- The structural scanner cannot see a proprietary term it has never been shown.
  That is why the local model's term extraction is a real stage rather than an
  optimization.
- Comments are tokenized aggressively (same rules as code), so a distinctive
  English word in a comment may become a token. The round trip restores it
  exactly.

## Development

```bash
npm run build
npm test        # 156 tests
```

Tests cover the vault round trip, token-prefix collisions, scanner false
positives, mock fidelity against known statistics, sandbox leakage, secret-file
omission, path traversal, sidecar timeouts and stdin guards, the env allowlist,
Windows command-line quoting, redirect refusal, stalled-body timeouts, comment
tokenization round trips, and the egress gate's ordering. The egress review
flow has its own coverage: instruction-block sanitization against the vault, the
task left raw for Gate 2, the review callback's approve/decline/`allowFindings`
paths, Gate 1 never routed through review, and a stage-3 regression test proving
a known vault literal in the request is tokenized before the outbound scan.

## License

[MIT](LICENSE) © iMatin
