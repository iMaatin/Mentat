import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDataset } from "../src/io/load.js";

/**
 * A fake interpreter with two behaviours, selected by MENTAT_STUB_MODE:
 *
 *  - "hang": answers the `probePython` probe (`-c "import pandas"`) then never
 *    exits, like a sidecar wedged on a file lock. Exercises the timeout.
 *  - otherwise: answers the probe, then exits immediately without reading
 *    stdin. The request write then hits a closed pipe — the EPIPE that used to
 *    arrive as an unhandled stream "error" and crash the whole process.
 *
 * One stub with a toggle, because `pythonExecutable()` resolves once per
 * process and caches the result; two separate stubs would never both be seen.
 */
async function makeStub(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mentat-pystub-"));
  if (process.platform === "win32") {
    const stub = join(dir, "py-stub.cmd");
    await writeFile(
      stub,
      [
        "@echo off",
        'if "%1"=="-c" exit /b 0',
        'if "%MENTAT_STUB_MODE%"=="hang" goto hang',
        "exit /b 1",
        ":hang",
        "goto hang",
        "",
      ].join("\r\n"),
    );
    return stub;
  }
  const stub = join(dir, "py-stub.sh");
  await writeFile(
    stub,
    [
      "#!/bin/sh",
      'if [ "$1" = "-c" ]; then exit 0; fi',
      'if [ "$MENTAT_STUB_MODE" = "hang" ]; then while :; do sleep 1; done; fi',
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(stub, 0o755);
  return stub;
}

describe("python sidecar hardening", () => {
  before(async () => {
    // Set before the first readDataset call: the interpreter is resolved once
    // per process, and the tests below rely on it being this stub.
    process.env.MENTAT_PYTHON = await makeStub();
  });

  it("kills a hung sidecar and rejects instead of hanging the pipeline", async () => {
    process.env.MENTAT_STUB_MODE = "hang";
    process.env.MENTAT_SIDECAR_TIMEOUT_MS = "700";
    try {
      await assert.rejects(() => readDataset("never-read.parquet", "parquet"), /timed out after 700ms/);
    } finally {
      delete process.env.MENTAT_SIDECAR_TIMEOUT_MS;
      delete process.env.MENTAT_STUB_MODE;
    }
  });

  it("survives a sidecar that exits before reading stdin", async () => {
    // An unhandled EPIPE on the child's stdin would crash this test process,
    // so reaching the rejection below is itself the regression assertion.
    await assert.rejects(() => readDataset("never-read.parquet", "parquet"), /sidecar failed \(exit 1\)/);
  });
});
