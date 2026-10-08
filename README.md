<h1 align="center">Mentat</h1>
<p align="center">A two-layer, privacy-first coding workflow built on the OpenCode runtime.</p>
<p align="center">
  <a href="https://github.com/iMaatin/Mentat/blob/dev/LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/iMaatin/Mentat?style=flat-square" /></a>
  <a href="https://github.com/iMaatin/Mentat/actions/workflows/mentat-core.yml"><img alt="Mentat core tests" src="https://github.com/iMaatin/Mentat/actions/workflows/mentat-core.yml/badge.svg?branch=dev" /></a>
</p>

> [!WARNING]
> Mentat v0 is experimental. The local model sees your real workspace; only the sanitized mock bundle is intended for the cloud. Read the [threat model](packages/mentat/docs/THREAT_MODEL.md) before using it with sensitive material. No sanitizer can detect every unknown proprietary phrase or prevent metadata leakage.

Mentat keeps real code, data, identifiers, and the identifier vault on your machine. A local agent prepares a small mock workspace, a deterministic gate scans the exact cloud-bound text, and a tool-less cloud subagent works only on that mock. The local agent then maps the answer back for human review.

```text
real code + data ──▶ local agent + sanitizer ──▶ mock bundle ──▶ tool-less cloud worker
                         ▲                                              │
                         └──────── local vault + reintegration ◀────────┘
```

## Quickstart

### 1. Get a compatible OpenCode runtime

Mentat does not yet publish its own binary releases. To build the runtime in this checkout, install [Bun 1.3.14](package.json) and build from source:

```bash
git clone https://github.com/iMaatin/Mentat.git
cd Mentat
bun install
bun run --cwd packages/opencode build --single
```

The build is self-contained and needs no access or permission from the upstream OpenCode team: the terminal emulator is vendored in [`packages/app/vendor`](packages/app/vendor), the AI model catalog is snapshotted in [`packages/script/snapshot`](packages/script/snapshot), and neither the install nor the build contacts `opencode.ai`, `models.opencode.ai`, `models.dev`, or another organization's GitHub repository. Refresh the catalog with `bun run refresh:models` when you want newer model data.

- `--single` builds only the current platform, which is much faster than the default all-platform build. Drop it (or use `--baseline`) to produce the full target matrix.
- The embedded web UI build is memory hungry: raise the Node heap (`NODE_OPTIONS=--max-old-space-size=3072 bun run --cwd packages/opencode build --single`) or pass `--skip-embed-web-ui` to skip it.
- On networks that cannot reach `pkg.pr.new`, a preview build used only by the console, stats, and enterprise apps, install the runtime subset instead: `bun install --filter @opencode-ai/opencode --filter @opencode-ai/app`.

On Linux x64, the generated binary is `packages/opencode/dist/opencode-linux-x64/bin/opencode`. Use the matching `opencode-<os>-<arch>` directory for your platform, then install the local build:

```bash
./install --binary packages/opencode/dist/opencode-linux-x64/bin/opencode
opencode --version
```

The install script puts the binary in `$HOME/bin` when that directory is usable, or `$HOME/.opencode/bin` otherwise. Set `OPENCODE_INSTALL_DIR` or `XDG_BIN_DIR` to override the destination; see [install paths](#install-paths).

**Upstream-only alternative:** without `--binary`, this repository's `install` script downloads official OpenCode releases from `anomalyco/opencode`, not Mentat fork releases. The source tree's matching runtime version is `1.18.35` (`packages/opencode/package.json`):

```bash
curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.35
```

This installs the upstream runtime only. Mentat's fork binaries are not published yet; `OPENCODE_REPO=iMaatin/Mentat` is not a supported installer override. Use a locally built binary with `./install --binary <path>` for this checkout.

### 2. Start the local model

In LM Studio, load a model and start its OpenAI-compatible local server (default `http://127.0.0.1:1234/v1`). Verify that the endpoint lists a model:

```bash
curl http://127.0.0.1:1234/v1/models
```

### 3. Configure local and cloud providers

Add the local LM Studio provider and your cloud provider in `opencode.json`. Select the cloud model for the `mentat-cloud` agent; configuration examples for OpenAI, Anthropic, Google, and DeepSeek are in [Mentat configuration](packages/mentat/docs/CONFIG.md).

### 4. Check readiness and run a task

Start OpenCode in a project containing Mentat's `.opencode` files. Ask the local Mentat agent to **run `mentat_status`** and report whether LM Studio is ready. `mentat_status` is an agent tool, not a TUI command. Then use:

```text
/mentat <your coding task>
```

The local agent gathers real context, `mentat_prepare` creates and scans the mock bundle, the cloud worker proposes a mock-space diff, and `mentat_reintegrate` maps it back. Review the result and run your tests; cloud output is not applied automatically.

### 5. Set project policy (optional but recommended)

Copy [`packages/mentat/mentat.example.json`](packages/mentat/mentat.example.json) to `mentat.json` at the project root or `.opencode/mentat.json`. Add project codenames, client names, and internal hosts to `denylist`; use the `alias` or `hash` column policy unless schema names are public.

## Use Mentat in another project

The plugin imports the core by a relative path. Preserve this layout in the target project; copying only `.opencode/` is not enough:

```text
<project>/
├── .opencode/
│   ├── agent/mentat.md
│   ├── agent/mentat-cloud.md
│   ├── command/mentat.md
│   └── plugins/mentat.ts
├── packages/mentat/          # the complete packages/mentat directory from this repo
└── mentat.json               # optional project policy
```

Copy those four `.opencode` files and the complete `packages/mentat/` directory, keeping their relative paths unchanged. OpenCode installs its plugin API dependency in the config directory when loading local plugins. Then follow [configuration](packages/mentat/docs/CONFIG.md) and the Quickstart above. This layout is documented, but a live LM Studio + cloud-vendor run in a separate project has not yet been verified; see the integration caveat below.

## Privacy boundary and current limits

- The local model and the Mentat plugin can read the real project. The cloud subagent has no tools and should receive only the mock task, mock code, and mock data.
- The deterministic egress gate blocks known vault terms and secret-shaped values, but cannot identify every unknown proprietary phrase. Metadata such as row counts can also be identifying; disable `data.includeRealCounts` if needed.
- v0 profiles CSV text only. Export other data formats locally before using them, and inspect the first mock bundle for each new repository or language.
- Reintegrated cloud output is untrusted and must be reviewed and tested locally. See the full [threat model](packages/mentat/docs/THREAT_MODEL.md).
- The deterministic core has automated tests. A live end-to-end run with LM Studio and a real cloud vendor still needs verification in an environment with both services configured.

## Install paths

The [`install`](install) script chooses its destination in this order:

1. `OPENCODE_INSTALL_DIR` — explicit override
2. `XDG_BIN_DIR`
3. `$HOME/bin` — created when possible
4. `$HOME/.opencode/bin` — fallback

Examples for a locally built binary:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" ./install --binary packages/opencode/dist/opencode-linux-x64/bin/opencode
XDG_BIN_DIR="$HOME/.local/bin" ./install --binary packages/opencode/dist/opencode-linux-x64/bin/opencode
```

## Development

- [`packages/mentat/README.md`](packages/mentat/README.md) — core package and plugin map
- [`packages/mentat/docs/CONFIG.md`](packages/mentat/docs/CONFIG.md) — LM Studio, cloud providers, and policy
- [`packages/mentat/docs/THREAT_MODEL.md`](packages/mentat/docs/THREAT_MODEL.md) — guarantees and residual risks
- [`packages/mentat/docs/BRANDING.md`](packages/mentat/docs/BRANDING.md) — v0 branding and compatibility decision
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development and contribution notes
- [Mentat core CI](.github/workflows/mentat-core.yml)

Mentat documentation is currently English-only; the inherited translated OpenCode READMEs were removed because they did not describe Mentat.
