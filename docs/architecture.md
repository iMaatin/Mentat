# Architecture

Mentat is four stages, each with an explicit boundary. The ordering **is** the
security property: any stage that produces something outbound runs its egress
check immediately before the network boundary, not once at the start.

```
 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
 │ 1 INVENTORY │──▶│ 2  SANDBOX  │──▶│ 3  DELEGATE │──▶│ 4   ADAPT   │
 └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘
  scan the repo      build the         scan, then        diff, restore,
  build the vault    synthetic         spawn opencode    apply to the
  profile datasets   mirror outside    inside the        real tree
  mint mock rows     the repo          sandbox
       │                 │                  │                 │
       ▼                 ▼                  ▼                 ▼
   local only        local only        network boundary    local only
```

> The [threat model](threat-model.md) states what is assumed and what can still
> leak; this document is the *how*. The [configuration reference](configuration.md)
> covers every knob.

## Stage 1 — inventory

Everything here is local and stays local.

- **Vault** (`core/vault`). Every proprietary identifier is mapped to a stable
  `zq_*` token. Tokens are deterministic given the vault, structurally neutral
  (they parse as ordinary identifiers), and reversible. The reverse map — the
  file that names your real identifiers — is written to the job directory with
  `0600` permissions and is the one artifact that must never be shared.
- **Dataset profiling** (`core/profile`). Each dataset is profiled: column
  types, null rates, null co-occurrence groups, correlations, category
  vocabularies, quantiles. Profiling is deterministic code, not model calls,
  because a model cannot be relied on to reproduce a co-occurrence pattern.
- **Term extraction** (`local/tasks`, layer 1). The local model reads a handful
  of high-signal source files and names which identifiers are *proprietary*
  rather than generic. This is a judgement about your business, which is why it
  is a model and not a regex — but it is advisory on top of the deterministic
  tokenizer, never the only line of defense.

## Stage 2 — sandbox

`core/sandbox/build.ts` mirrors the repository into a directory **outside** it,
and refuses to do otherwise: a sandbox inside the project would let the cloud
agent's tools walk up into the real tree, turning the guarantee into a promise.

What happens to each file:

| Kind | Treatment |
| --- | --- |
| Code | Segment-aware sanitization: identifiers → tokens, comments and strings scrubbed, structure byte-preserved. |
| Config | Same as code. |
| Prose (`.md`, `.rst`, …) | Wholesale scrub: vault terms, emails, IPs, URLs replaced; snake/Pascal references tokenized. |
| Data (csv, parquet, …) | Never copied. Replaced by synthetic rows generated from the profile, or by an explicit omission note. |
| Binary | Omitted. |
| Secret files (`.env*`, `*.pem`, `id_rsa*`, `.npmrc`, `.aws/`, `.ssh/`, …) | Omitted, recorded with an explicit reason. A `KEY=value` line is not an identifier and tokenization cannot protect it. |

Filenames are tokenized on the same authority as identifiers: `acme_billing.py`
identifies an organization as plainly as the function names inside it. Standard
tooling filenames (`package.json`, `requirements.txt`, …) are preserved,
because renaming them breaks the build for no privacy gain.

The sandbox receives only a redacted manifest summary. The full manifest, which
names real paths and the real root, is written to the job directory.

Finally the sandbox is committed to a local git baseline. That baseline is what
lets stage 4 recover exactly what the cloud model changed — including files it
created — without depending on its history.

## Stage 3 — delegate

The rewritten prompt first gets a **deterministic `vault.sanitize` pass**
(`pipeline.ts`), then `cloud/delegate.ts` runs the gates **in order**, and the
spawn is last:

1. `assertNotExfiltrated` — the payload must not reference `.mentat/`,
   `vault.json`, `prompt.txt`, or a `sandbox/` path. Patterns are anchored to
   path boundaries. Never overridable.
2. `assertClean` — every vault literal plus ~20 structural rules (credentials,
   private addresses, internal hosts, live emails, Luhn-validated cards). A
   finding normally aborts; it is never logged and passed along. The one
   exception is a human-approved override — the CLI surfaces the findings (rule,
   severity, count, excerpt) and an interactive `[y/N]` (or `--allow-egress`)
   lets the operator proceed to layer 2 anyway. The findings and
   `egressApproved: true` are recorded on the run; without a TTY and without the
   flag, the gate stays fail-closed.
3. Only now is a process spawned: `opencode run` headless, with the sandbox as
   its working directory.

The fixed instruction block `delegate` prepends is sanitized against the vault
too, because aggressive comment tokenization can mint an entry that collides
with an ordinary instruction word ("directory") and would otherwise block an
otherwise-clean run. The task itself is deliberately left raw, so an upstream
that skipped its own sanitize is still caught by Gate 2 rather than silently
repaired.

The child process receives an **allowlisted environment** (see
[threat-model.md](threat-model.md)), a 4 MiB capture cap per stream, and a
timeout. On Windows, npm's `opencode.cmd` shim is driven through
`cmd.exe /d /s /c` with a quoted command line, because Node ≥ 20.12 refuses to
spawn `.cmd` files directly (CVE-2024-27980 mitigation) — and no `shell: true`
is used anywhere, so there is no shell to re-inject.

## Stage 4 — adapt

The sandbox diff is collected against the baseline commit, parsed into per-file
hunks, and every token is restored by exact substitution. Applying the restored
diff to the real tree matches context with tolerance for small offsets; nothing
is forced. Files whose hunks do not match are reported individually and the
sandbox is kept for manual reconciliation.

Token substitution preserves line count and indentation, which is what makes a
diff against the mock a clean textual reverse-mapping even in paths.

## Failure semantics

- Every stage persists its report transition to `.mentat/jobs/<id>/report.json`
  as it advances, so a crash leaves an accurate record.
- A blocked or failed delegation is recorded as `failed` with the reason,
  whether it arrived as a returned value or a thrown error.
- Every subprocess has a timeout (git 120 s, sidecar 5 min by default, cloud
  run 30 min, plugin command 45 min) and every timer is cleared on completion,
  so a finished run exits promptly and a hung one fails closed.
