# Vendored dependencies

Tarballs in this directory are committed so installs and builds never reach out to
third-party source repositories that this project does not control.

## `opencode-ai-client-1.17.13-v2.tgz`

Referenced from `packages/app/package.json` and `packages/session-ui/package.json`
as `file:vendor/opencode-ai-client-1.17.13-v2.tgz`.

## `ghostty-web-0.3.0-83c0a07.tgz`

Terminal emulator used by `packages/app/src/components/terminal.tsx`. Built from
`coder/ghostty-web` (MIT, `ghostty-web.LICENSE`) at commit
`83c0a07b8628b748aed073b232cb4b52a6ca11c1` of the `anomalyco/ghostty-web` fork,
which is the revision the app is written against. It replaces the previous
`github:anomalyco/ghostty-web#83c0a07...` dependency so `bun install` works with no
GitHub access and no credentials for another organization's repository.

The tarball keeps the package layout unchanged (`dist/`, `ghostty-vt.wasm`,
`package.json`, `LICENSE`), so it installs exactly like the git dependency did.

SHA-256: `46cdece3e6a113ec6c7c29424bbb7350e63e25e4fc03ddde7327cbfd71bfc299`
(the `sha512` recorded in `bun.lock` is derived from this file).

To refresh it:

```bash
curl -sSL "$(printf '%s' 'https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>')" -o /tmp/ghostty-web.tgz
mkdir -p /tmp/ghostty-web/package
tar xzf /tmp/ghostty-web.tgz -C /tmp/ghostty-web --strip-components=1
cp -r /tmp/ghostty-web/{dist,ghostty-vt.wasm,README.md,LICENSE,package.json} /tmp/ghostty-web/package/
tar --sort=name -C /tmp/ghostty-web -cf - package | gzip -n -9 > packages/app/vendor/ghostty-web-<version>-<shortsha>.tgz
```

Then update the `ghostty-web` entry in `packages/app/package.json` and any imports
if the public API changed.
