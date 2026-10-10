/**
 * Public API of `@mentat/core`.
 *
 * Everything privacy-relevant is exported here so the CLI, the tests, and any
 * future plugin surface the same primitives. The most important exports are
 * `assertClean` (the egress gate) and `assertNotExfiltrated` (the boundary
 * check); both fail closed and both must be called on the exact bytes that will
 * leave the machine.
 */

export {
  Vault,
  TOKEN_PREFIX,
  isStopword,
  detectShape,
  type VaultEntry,
  type IdentifierKind,
  type IdentifierShape,
} from "./vault/Vault.js";

export {
  scan,
  assertClean,
  formatReport,
  LeakDetected,
  type Finding,
  type ScanReport,
  type ScanOptions,
  type Severity,
} from "./scan/scan.js";

export {
  languageFor,
  segment,
  sanitizeSource,
  scrubProse,
  isSensitiveColumn,
  type Language,
  type Segment,
  type SanitizeOptions,
  type SanitizeResult,
} from "./redact/source.js";

export {
  profileTable,
  summarizeProfile,
  inferDtype,
  looksLikeIdentifierColumn,
  type TableProfile,
  type ColumnProfile,
  type Quantiles,
  type Dtype,
  type ProfileOptions,
} from "./profile/profile.js";

export {
  generateTable,
  redactCategories,
  compareProfiles,
  cholesky,
  Rng,
  type GenerateOptions,
  type GeneratedTable,
  type FidelityReport,
} from "./mock/generate.js";

export {
  readDataset,
  writeDataset,
  formatFor,
  isNativeFormat,
  supportsFormat,
  pythonAvailable,
  pythonExecutable,
  parseDelimited,
  serializeDelimited,
  PythonUnavailable,
  type Dataset,
  type DatasetFormat,
} from "./io/load.js";

export {
  buildSandbox,
  collectNewFiles,
  type DatasetMockEntry,
  type SandboxManifest,
  type SandboxFile,
  type OmissionRecord,
  type BuildOptions,
} from "./sandbox/build.js";

export {
  parseDiff,
  applyDiff,
  applyHunks,
  initSandboxBaseline,
  collectSandboxDiff,
  git,
  type ParsedDiff,
  type DiffFile,
  type ApplyReport,
  type ApplyFileReport,
  type ApplyOptions,
} from "./patch/apply.js";

export {
  jobPaths,
  newJobId,
  ensureJobRoot,
  saveVault,
  loadVault,
  saveReport,
  loadReport,
  listJobs,
  removeJob,
  assertNotExfiltrated,
  BoundaryViolation,
  FORBIDDEN_OUTBOUND,
  type JobPaths,
  type JobReport,
} from "./job/job.js";