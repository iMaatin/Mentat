# Mentat branding and compatibility decision (v0)

## Decision

Use **Mentat** as the user-facing project and feature name. Describe the repository as an independent fork built on the OpenCode codebase; do not use upstream OpenCode logos, badges, release links, or wording that suggests the upstream team publishes or supports Mentat.

For v0, keep upstream operational names where changing them would break compatibility:

- CLI and binary: `opencode`
- runtime package: `opencode`
- project configuration and plugin directories: `.opencode/`
- plugin API package: `@opencode-ai/plugin`

Do not rebrand the binary/package, migrate `~/.opencode` paths, or claim desktop-app support in v0. Revisit these changes only with a Mentat-owned release pipeline, upgrade/migration plan, and desktop support/testing plan.

## Distribution note

The checked-in installer without `--binary` downloads upstream OpenCode releases from `anomalyco/opencode`; it does not download Mentat fork builds. Until the fork publishes and tests its own release assets, document the source build and `./install --binary <path>` workflow and label upstream install commands clearly.
