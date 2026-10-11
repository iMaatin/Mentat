/**
 * Test runner.
 *
 * Enumerates the compiled test files and hands `node --test` explicit paths.
 *
 * A glob is deliberately not passed to `node --test`: test-runner glob support
 * only landed in Node 21. On Node 20 the pattern is treated as a literal path,
 * so it matches nothing and the run fails with "Could not find ..." — which is
 * exactly what broke CI on the Node 20 matrix legs. `engines` still declares
 * Node >= 20.11, so the runner has to work there.
 *
 * npm runs scripts without a shell, so the glob is never expanded by one either;
 * enumerating here is the only portable option. A miss is reported explicitly
 * rather than silently passing zero tests, which would otherwise look green.
 */

import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Depth-first search for files matching a predicate, skipping nothing here. */
function walk(dir, match, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // A package that has not been built has no dist/ at all.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, out);
    else if (entry.isFile() && match(entry.name)) out.push(full);
  }
  return out;
}

const testFiles = walk(join(root, "packages"), (name) => name.endsWith(".test.js"))
  .sort()
  // Explicit paths are relative so the reported names stay short and identical
  // on Windows and POSIX.
  .map((full) => relative(root, full).split(sep).join("/"));

if (testFiles.length === 0) {
  console.error("No compiled test files found under packages/*/dist. Run `npm run build` first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  stdio: "inherit",
});

// A signal (spawnSync returns null for exitCode) is still a failure.
process.exit(result.status ?? 1);
