# Mentat

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

## Quick start

```bash
npm install
npm run build

node packages/cli/dist/src/main.js init        # writes .mentat/config.json
node packages/cli/dist/src/main.js doctor      # checks both layers
node packages/cli/dist/src/main.js ask "add retry with backoff to the ingest job"
```

Requirements: Node 20.11+, a local model in LM Studio, and `opencode` on PATH for
the cloud layer. Parquet, Excel, and SQLite additionally need
`pip install pandas pyarrow openpyxl`; CSV, TSV, JSON, and JSONL need nothing.

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
`--prose`, `--no-local`, `--verbose`.

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

`dataclass`, `pandas`, `read_parquet`, `True`, and the rest of the standard and
third-party surface survive intact. That matters more than it sounds: tokenizing
`from dataclasses import dataclass` produces code that does not parse, and a mock
the cloud model cannot run is worse than no mock.

Filenames are tokenized too (`acme_billing.py` → `zq_mod_mod_001.py`), because a
filename identifies an organization as plainly as an identifier does. Standard
tooling names like `package.json` and `requirements.txt` are preserved, since
renaming those breaks the build.

## The egress gate

Three checks run in order, and the third one is the only thing standing between
a payload and the network:

1. `assertNotExfiltrated` — the payload must not reference `vault.json`,
   `prompt.txt`, or the sandbox.
2. `assertClean` — every vault literal plus ~20 structural rules (credentials,
   private addresses, internal hosts, live emails, cards validated by Luhn).
3. Only then is a process spawned.

Both checks **fail closed**. A finding aborts the run; it is never logged and
passed along. Guard runs in both directions: the CLI gates the prompt, and the
OpenCode plugin gates every outbound request in a plain session so that opening
`opencode` directly in a Mentat project cannot quietly ship your files either.

## Layer 1 refuses to be remote

Layer 1 is pointed at `http://127.0.0.1:1234/v1` and verified to be loopback.
If `MENTAT_LOCAL_BASE_URL` is set to a remote address, Mentat refuses to start,
because a remote layer 1 would upload your prompt and code *before* any
redaction had run — defeating the entire design. Override with
`MENTAT_ALLOW_REMOTE_LOCAL=1` only if you understand what that waives.

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
.mentat/     per-job artifacts; gitignored, never leaves the machine
```

Each job keeps your original prompt, the de-identified prompt, the vault, the
sandbox, the restored patch, and a report:

```
.mentat/jobs/20260101-142233-a7f/
  prompt.txt          prompt.sanitized     vault.json   (0600)
  result.patch        report.json          sandbox/
```

## Configuration

`.mentat/config.json`, JSONC. `cloudModel`, `cloudAgent`, `localModel`,
`localBaseUrl`, `mockRows`, `seed`, `exclude`, `dataGlobs`, `sensitiveColumns`.

```jsonc
{
  "cloudModel": "anthropic/claude-sonnet-4-5",
  "localModel": "qwen3-30b-a3b",
  "mockRows": 200,
  "sensitiveColumns": ["email", "name", "phone", "address", "*_notes"]
}
```

`sensitiveColumns` matches by word containment, so `email` covers
`customer_email` and `billing_email_address`. Use `"*"` to match anything.

## OpenCode plugin

```jsonc
// opencode.jsonc
{
  "plugins": [{ "package": "./packages/oc-plugin", "options": { "guard": true } }]
}
```

Adds `/mentat <request>` and the outbound guard. It holds none of the privacy
logic; it delegates to the CLI.

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

## Development

```bash
npm run build
npm test        # 106 tests
```

Tests cover the vault round trip, token-prefix collisions, scanner false
positives, mock fidelity against known statistics, sandbox leakage, path
traversal, and the egress gate's ordering.