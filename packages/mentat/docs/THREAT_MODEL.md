# Mentat threat model

This document states precisely what "your code and data never leave your system" means in Mentat v0, what is enforced deterministically, and what remains your responsibility.

## Assets

| Asset | Location | May leave the machine? |
|---|---|---|
| Real code, data, prompts | Your filesystem + local (LM Studio) session | **Never** |
| Identifier vault (real⇄mock map) | `.mentat/vaults/*.json` (chmod 600, gitignored) | **Never** |
| Audit log (hashes, redacted counts) | `.mentat/audit.log.jsonl` (gitignored) | **Never** |
| Mock bundle (sanitized task + mock code + mock data) | `.mentat/bundles/` + cloud subagent prompt | Yes — that is its purpose |

## Trust boundaries

```
┌─ YOUR MACHINE (trusted) ──────────────────────────────────┐
│  real files · vault · audit log · local LLM (LM Studio)   │
│                              │ egress gate (deterministic) │
└──────────────────────────────│─────────────────────────────┘
                               │ mock bundle only
                               ▼
                    ┌─────────────────────┐
                    │  CLOUD MODEL        │  UNTRUSTED:
                    │  (any vendor)       │  - sees mock only
                    └─────────────────────┘  - output is untrusted input
```

## Guaranteed by deterministic code (not by the LLM)

1. **Three chokepoints, all fail-closed.** The prepare gate, the `task→mentat-cloud` hook, and the any-message-to-cloud hook each scan exact outbound bytes. Any hit → throw, nothing sent. An LLM "forgetting" cannot bypass them.
2. **Vault completeness for known terms.** Every identifier renamed from real files, every path stem, every column name (under `alias`/`hash`), every `entities`/`denylist` term is scanned for in the egress bytes (word-boundary for wordish terms, substring otherwise).
3. **Secret-shaped values.** Built-in patterns (cloud keys, private keys, tokens, connection strings, `api_key = …` assignments) plus high-entropy token detection apply to every payload.
4. **Network literals.** URL hosts reduce to documentation apexes (`example.com`/`example.org`/loopback), mailboxes to `user@example.com`, private IPs to TEST-NET. Real hosts cannot survive in strings, comments, or the task.
5. **Mock vocabulary is collision-checked.** Generated names, kind labels, and fake data words are checked against every known real token, so filler can neither leak nor false-positive.
6. **Findings never carry secrets.** Audit records and error messages contain hashes + redacted excerpts (`⟦bi***ng⟧`), never the matched value.
7. **Cloud has zero tools.** The `mentat-cloud` agent sets `tools: {"*": false}` — it cannot read files, run commands, or call back. It reasons from the prompt alone.

## Residual risks (read carefully)

1. **Unknown proprietary prose.** If the task or a kept comment/string contains a proprietary term Mentat has never seen (not in files, not in `entities`/`denylist`), no deterministic check can flag it. Mitigations: `entities` per call, project `denylist`, `strings`/`comments: "elide"` for paranoid projects, and the Layer-1 prompt instructing the local model to rephrase. This is the fundamental limit of any sanitizer — the vault can only protect what it knows.
2. **Metadata leakage.** Unless disabled: real row counts (`includeRealCounts`), file counts, approximate sizes, dtypes, null rates, value ranges. Shape without content — but shape can identify a dataset. Disable `includeRealCounts` if table sizes are sensitive.
3. **Column-name policy `keep`.** By definition sends real schema words. Use `alias` (default) or `hash` unless schema words are public.
4. **Untrusted cloud output.** Cloud diffs are translated textually and NEVER auto-applied. Prompt-injection via cloud output (malicious instructions, hallucinated APIs) is countered by: mapping report + warnings, mandatory local review, and running tests. Never pipe cloud output into a shell.
5. **Vault file protection.** The vault is the crown jewel: anyone with your `.mentat/` can de-anonymize bundles. It is gitignored + chmod 600, but disk encryption, backups, and shared machines are your responsibility. Delete stale vaults (`.mentat/vaults/`) when done.
6. **Local model exfiltration.** The local LLM sees everything real. A compromised/malicious local model or a prompt-injection in your own files could in principle steer the agent to leak — the deterministic hooks still scan cloud-bound traffic, but prefer models you trust and keep `chat.message` guard enabled.
7. **Tokenizer heuristic.** `maxBundleTokens` uses chars/4 — a budgeting heuristic, not a security property. Over/under-counting only affects truncation, never the gate.
8. **Non-CSV data.** v0 profiles CSV text only. Parquet/Excel/DBs must be exported to CSV first (locally). Binary formats are out of scope.
9. **Language coverage.** The skeletonizer's comment/string splitter is a small tokenizer, not a parser. Exotic syntax (nested template literals, macros generating identifiers) may rename imperfectly — the gate still catches known terms, but review first-run bundles on a new language.

## Operational checklist

- [ ] `.mentat/` is gitignored (default) and never committed.
- [ ] Session model is `lmstudio/*` (or another `localProviders` entry) before sharing anything real — verify with `mentat_status`.
- [ ] `mentat-cloud` agent model points at your intended cloud vendor; its `tools: {"*": false}` is intact.
- [ ] Project `denylist` lists codenames/client names; `entities` used per call for task-specific terms.
- [ ] First bundle on a new repo/language reviewed by eye (`.mentat/bundles/<session>/<id>.md`).
- [ ] Stale vaults deleted after the work is done.
