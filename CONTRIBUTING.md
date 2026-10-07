# Contributing to Mentat

Mentat is an independent fork built on the OpenCode codebase. We welcome focused changes to Mentat and its runtime. For Mentat-specific behavior, tests, or documentation, use this repository's pull requests; GitHub Issues are currently disabled, so include the relevant context in your PR description. Do not imply that the upstream OpenCode team maintains or releases Mentat.

Here are the most common types of changes that get merged:

- Bug fixes
- Additional LSPs / Formatters
- Improvements to LLM performance
- Support for new providers
- Fixes for environment-specific quirks
- Missing standard behavior
- Documentation improvements

However, any new Mentat UI or core product feature should be discussed with the Mentat maintainers before implementation.

If you are unsure whether a PR would be accepted, ask a maintainer or review the repository's open pull requests. The labels and issue templates can be used if GitHub Issues are enabled in the future.

> [!NOTE]
> PRs that ignore these guardrails will likely be closed.

Want to take on an issue? Leave a comment and a maintainer may assign it to you unless it is something we are already working on.

## Adding New Providers

New providers shouldn't require many if ANY code changes, but if you want to add support for a new provider first make a PR to:
https://github.com/anomalyco/models.dev

## Developing the OpenCode runtime

- Requirements: Bun 1.3+
- Install dependencies and start the dev server from the repo root:

  ```bash
  bun install
  bun dev
  ```

### Running against a different directory

By default, `bun dev` runs OpenCode in the `packages/opencode` directory. To run it against a different directory or repository:

```bash
bun dev <directory>
```

To run OpenCode in the root of the opencode repo itself:

```bash
bun dev .
```

### Building a "localcode"

To compile a standalone executable:

```bash
./packages/opencode/script/build.ts --single
```

Then run it with:

```bash
./packages/opencode/dist/opencode-<platform>/bin/opencode
```

Replace `<platform>` with your platform (e.g., `darwin-arm64`, `linux-x64`).

### Developing Mentat

- `packages/mentat/` contains `@mentat/core`, the deterministic privacy boundary. Its tests must use synthetic fixtures; core code must not add network calls or invoke an LLM.
- Run the core suite with `bun run --cwd packages/mentat test` (or `bun test test/*.test.ts` from `packages/mentat/`). Run its typecheck with `bun run --cwd packages/mentat typecheck`.
- Plugin hooks and tools live in `.opencode/plugins/mentat.ts`; the local and tool-less cloud agents are in `.opencode/agent/`, and `/mentat` is defined in `.opencode/command/mentat.md`.
- Changes to sanitization, vault mapping, mock generation, or reintegration should add regression tests for both the expected result and the fail-closed egress behavior. Never add real customer data, credentials, vaults, or `.mentat/` artifacts to tests or commits.
- Live provider integration is a manual check requiring LM Studio and a configured cloud vendor. Keep test data synthetic, verify the model/provider routing, and inspect the generated mock bundle before involving a cloud model.

- Core pieces:
  - `packages/opencode`: OpenCode core business logic & server.
  - `packages/opencode/src/cli/cmd/tui/`: The TUI code, written in SolidJS with [opentui](https://github.com/sst/opentui)
  - `packages/app`: The shared web UI components, written in SolidJS
  - `packages/desktop`: The native desktop app, built with Electron (wraps `packages/app`)
  - `packages/plugin`: Source for `@opencode-ai/plugin`

### Understanding bun dev vs opencode

During development, `bun dev` is the local equivalent of the built `opencode` command. Both run the same CLI interface:

```bash
# Development (from project root)
bun dev --help           # Show all available commands
bun dev serve            # Start headless API server
bun dev web              # Start server + open web interface
bun dev <directory>      # Start TUI in specific directory

# Production
opencode --help          # Show all available commands
opencode serve           # Start headless API server
opencode web             # Start server + open web interface
opencode <directory>     # Start TUI in specific directory
```

### Running the API Server

To start the OpenCode headless API server:

```bash
bun dev serve
```

This starts the headless server on port 4096 by default. You can specify a different port:

```bash
bun dev serve --port 8080
```

### Running the Web App

To test UI changes during development:

1. **First, start the OpenCode server** (see [Running the API Server](#running-the-api-server) section above)
2. **Then run the web app:**

```bash
bun run --cwd packages/app dev
```

This starts a local dev server at http://localhost:5173 (or similar port shown in output). Most UI changes can be tested here, but the server must be running for full functionality.

### Running the Desktop App

The desktop app is an Electron application that wraps the web UI.

To run the desktop app in development:

```bash
bun run --cwd packages/desktop dev
```

To create a production build and package the app:

```bash
bun run --cwd packages/desktop build
bun run --cwd packages/desktop package
```

> [!NOTE]
> If you make changes to the API or SDK (e.g. `packages/opencode/src/server/server.ts`), run `./script/generate.ts` to regenerate the SDK and related files.

Please try to follow the [style guide](./AGENTS.md)

### Setting up a Debugger

Bun debugging is currently rough around the edges. We hope this guide helps you get set up and avoid some pain points.

The most reliable way to debug OpenCode is to run it manually in a terminal via `bun run --inspect=<url> dev ...` and attach
your debugger via that URL. Other methods can result in breakpoints being mapped incorrectly, at least in VSCode (YMMV).

Caveats:

- If you want to run the OpenCode TUI and have breakpoints triggered in the server code, you might need to run `bun dev spawn` instead of
  the usual `bun dev`. This is because `bun dev` runs the server in a worker thread and breakpoints might not work there.
- If `spawn` does not work for you, you can debug the server separately:
  - Debug server: `bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096`,
    then attach TUI with `opencode attach http://localhost:4096`
  - Debug TUI: `bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts`

Other tips and tricks:

- You might want to use `--inspect-wait` or `--inspect-brk` instead of `--inspect`, depending on your workflow
- Specifying `--inspect=ws://localhost:6499/` on every invocation can be tiresome, you may want to `export BUN_OPTIONS=--inspect=ws://localhost:6499/` instead

#### VSCode Setup

If you use VSCode, you can use our example configurations [.vscode/settings.example.json](.vscode/settings.example.json) and [.vscode/launch.example.json](.vscode/launch.example.json).

Some debug methods that can be problematic:

- Debug configurations with `"request": "launch"` can have breakpoints incorrectly mapped and thus unusable
- The same problem arises when running OpenCode in the VSCode `JavaScript Debug Terminal`

With that said, you may want to try these methods, as they might work for you.

## Pull Request Expectations

### Issue and PR context

GitHub Issues are currently disabled for this repository. Do not try to create an issue; explain the problem and rationale in the PR template's **Issue for this PR** section instead. The automated PR checks exempt `docs`, `refactor`, and `feat` titles from requiring a linked issue. If you are submitting a `fix`, `chore`, or `test` PR, contact a maintainer first because the current issue-link check cannot be satisfied while Issues are disabled.

### General Requirements

- Keep pull requests small and focused
- Explain the issue and why your change fixes it
- Before adding new functionality, ensure it doesn't already exist elsewhere in the codebase

### UI Changes

If your PR includes UI changes, please include screenshots or videos showing the before and after. This helps maintainers review faster and gives you quicker feedback.

### Logic Changes

For non-UI changes (bug fixes, new features, refactors), explain **how you verified it works**:

- What did you test?
- How can a reviewer reproduce/confirm the fix?

### No AI-Generated Walls of Text

Long, AI-generated PR descriptions and issues are not acceptable and may be ignored. Respect the maintainers' time:

- Write short, focused descriptions
- Explain what changed and why in your own words
- If you can't explain it briefly, your PR might be too large

### PR Titles

PR titles should follow conventional commit standards:

- `feat:` new feature or functionality
- `fix:` bug fix
- `docs:` documentation or README changes
- `chore:` maintenance tasks, dependency updates, etc.
- `refactor:` code refactoring without changing behavior
- `test:` adding or updating tests

You can optionally include a scope to indicate which package is affected:

- `feat(app):` feature in the app package
- `fix(desktop):` bug fix in the desktop package
- `chore(opencode):` maintenance in the opencode package

Examples:

- `docs: update contributing guidelines`
- `fix: resolve crash on startup`
- `feat: add dark mode support`
- `feat(app): add dark mode support`
- `fix(desktop): resolve crash on startup`
- `chore: bump dependency versions`

### Style Preferences

These are not strictly enforced, they are just general guidelines:

- **Functions:** Keep logic within a single function unless breaking it out adds clear reuse or composition benefits.
- **Destructuring:** Do not do unnecessary destructuring of variables.
- **Control flow:** Avoid `else` statements.
- **Error handling:** Prefer `.catch(...)` instead of `try`/`catch` when possible.
- **Types:** Reach for precise types and avoid `any`.
- **Variables:** Stick to immutable patterns and avoid `let`.
- **Naming:** Choose concise single-word identifiers when they remain descriptive.
- **Runtime APIs:** Use Bun helpers such as `Bun.file()` when they fit the use case.

## Feature Requests

For net-new Mentat functionality, start with a design conversation before implementation. GitHub Issues are currently disabled, so use the repository's PR discussion or contact a maintainer to describe the problem, your proposed approach, and why it belongs in Mentat. Changes specifically to the inherited OpenCode runtime may also be proposed upstream when appropriate.

## Issue Requirements

GitHub Issues are currently disabled. If they are enabled later, use the repository's bug report, feature request, or question template and provide meaningful content instead of placeholders. Until then, use the **Issue for this PR** section of the pull-request template to explain the context (or state that Issues are disabled for a documentation-only PR).
