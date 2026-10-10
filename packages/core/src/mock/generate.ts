/**
 * Synthetic data generation from a statistical profile.
 *
 * This is deterministic code, not a model call. The local model is used for
 * understanding your *prompt*; producing the mock table itself is better done
 * with an explicit generator, because the generator can guarantee the properties
 * you care about (same null mask structure, same correlation, same category
 * vocabulary) instead of hoping a language model reproduces them.
 *
 * Privacy properties:
 *  - Category vocabularies are inherited from the profile. The profile is built
 *    from the real data, so a categorical column whose values are customer names
 *    is NOT safe to inherit. Callers must pass such columns through
 *    {@link redactCategories} before this generator runs.
 *  - Numeric columns are sampled from quantiles, so no real value is reproduced.
 *  - Identifier-like columns get freshly minted, structurally valid identifiers.
 */

import {
  profileTable,
  type ColumnProfile,
  type Dtype,
  type Quantiles,
  type TableProfile,
} from "../profile/profile.js";

export interface GenerateOptions {
  readonly rows?: number;
  readonly seed?: number;
  /** Columns whose category vocabulary came from real data and must be replaced. */
  readonly redactCategories?: Readonly<Record<string, readonly string[]>>;
  /** Per-column override of the generated row count. */
  readonly rowOverrides?: Readonly<Record<string, number>>;
}

export interface GeneratedTable {
  readonly name: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly profile: TableProfile;
}

const DEFAULT_ROWS = 200;

/** Deterministic PRNG (mulberry32). Reproducible mocks make bugs debuggable. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  bool(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("cannot pick from empty list");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Box-Muller. Standard normal, used with a correlation matrix. */
  normal(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/**
 * Cholesky decomposition of a correlation matrix, used to generate correlated
 * normals. Falls back to the identity when the matrix is not positive definite
 * (which happens with sparse data), because a slightly wrong correlation is
 * better than a crash.
 */
export function cholesky(matrix: readonly (readonly number[])[]): number[][] {
  const n = matrix.length;
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i]?.[j] ?? 0;
      for (let k = 0; k < j; k++) sum -= (l[i]?.[k] ?? 0) * (l[j]?.[k] ?? 0);
      if (i === j) {
        l[i]![j] = Math.sqrt(Math.max(sum, 1e-6));
      } else {
        l[i]![j] = sum / (l[j]![j] ?? 1);
      }
    }
  }
  return l;
}

/**
 * Inverse transform sampling against the profile's quantiles.
 *
 * The five quantiles are treated as knots on a normal CDF, so the sampled
 * marginal reproduces the original skew and tail weight. Integer columns are
 * rounded on the way out; without that, a float intermediate would make the
 * generated column profile as `float` and the dtype would drift.
 */
function sampleFromQuantiles(q: Quantiles, z: number, dtype: Dtype, _rng: Rng): number {
  // Knots are placed symmetrically about the median so the induced marginal is
  // symmetric too. An asymmetric placement (for example 0.15/0.35/0.5/0.75/0.99)
  // compresses the upper half of any symmetric distribution and shifts the
  // sampled median downward by a visible margin.
  const points: ReadonlyArray<readonly [number, number]> = [
    [0.01, q.min],
    [0.25, q.q25],
    [0.5, q.median],
    [0.75, q.q75],
    [0.99, q.max],
  ];
  const t = normalCdf(z);
  // Clamp to the observed domain. Inverse-CDF sampling is inherently unbounded
  // in the tails, and a value outside the real column's range (a churn score of
  // 1.03 when the real maximum is 1.0) is both wrong and a signal the cloud
  // model would act on incorrectly.
  const raw = interpolate(t, points);
  const value = Math.min(q.max, Math.max(q.min, raw));

  if (dtype === "int") return Math.round(value);
  return value;
}

/**
 * Piecewise-linear inverse CDF over the quantile knots, with linear tails.
 */
function interpolate(t: number, points: ReadonlyArray<readonly [number, number]>): number {
  const first = points[0] as readonly [number, number];
  const second = points[1] as readonly [number, number];
  if (t <= first[0]) {
    // Left tail: extrapolate back from the min..q25 segment with a strongly
    // reduced slope, so the rare overshoot stays small. A steeper tail would
    // push many samples past the bound, which then clamp and pile up on the
    // boundary value.
    const slope = (second[1] - first[1]) / (second[0] - first[0]);
    return first[1] - slope * (first[0] - t) * 0.15;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const [t0, v0] = points[i] as readonly [number, number];
    const [t1, v1] = points[i + 1] as readonly [number, number];
    if (t <= t1) return lerp(v0, v1, (t - t0) / (t1 - t0));
  }
  // Right tail: mirror of the left.
  const last = points[points.length - 1] as readonly [number, number];
  const prev = points[points.length - 2] as readonly [number, number];
  const slope = (last[1] - prev[1]) / (last[0] - prev[0]);
  return last[1] + slope * (t - last[0]) * 0.15;
}

function normalCdf(z: number): number {
  // Abramowitz-Stegun 7.1.26 approximation. Plenty accurate for sampling.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function weightedPick(values: readonly string[], weights: readonly number[], r: number): string {
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += weights[i] ?? 0;
    if (r <= acc) return values[i] as string;
  }
  return values[values.length - 1] as string;
}

const SYNTHETIC_DOMAINS = [
  "example.com", "example.org", "example.net", "test.invalid", "sample.dev",
];

/**
 * Domains reserved by RFC 2606 and RFC 6761. These are the only hosts that may
 * legally appear in documentation, and using them means a synthetic address can
 * never be deliverable or collide with a real mailbox.
 */
const RESERVED_EMAIL_DOMAIN = "example.com";

/**
 * Generates a table that matches `profile`'s shape. Returns rows plus the
 * profile of what was actually generated, so you can verify fidelity by
 * comparing the two profiles.
 */
export function generateTable(profile: TableProfile, options: GenerateOptions = {}): GeneratedTable {
  const rowCount = Math.max(1, options.rows ?? DEFAULT_ROWS);
  const rng = new Rng(options.seed ?? hashSeed(profile.name));
  const redact = options.redactCategories ?? {};
  const numeric = profile.numericIndices.map((i) => profile.columns[i]).filter((c): c is ColumnProfile => !!c);
  const chol = cholesky(profile.correlation.length > 0 ? profile.correlation : []);
  const redactedDicts = new Map<string, readonly string[]>();

  // Build replacement vocabularies for any column flagged as sensitive.
  for (const [col, replacement] of Object.entries(redact)) {
    redactedDicts.set(col, buildDictionary(col, replacement, rng));
  }

  // Group members share a null mask, mirroring the real co-occurrence.
  const groupOf = new Map<number, readonly number[]>();
  for (const group of profile.nullGroups) {
    for (const idx of group) groupOf.set(idx, group);
  }

  const rows: Record<string, unknown>[] = [];
  for (let r = 0; r < rowCount; r++) {
    // One shared null decision per co-occurring group. This must be rebuilt for
    // every row: reusing it across rows would make the whole column share a
    // single outcome.
    const groupNulls = new Map<string, boolean>();
    const row: Record<string, unknown> = {};
    const forcedNull = new Set<number>();
    if (rng.bool(profile.fullyNullRowRate)) {
      for (const col of profile.columns) forcedNull.add(profile.columns.indexOf(col));
    }

    // Correlated normal draw, shared by all numeric columns in this row.
    //
    // The standard normals must be drawn ONCE per row and then propagated by
    // forward substitution through the Cholesky factor. Drawing a fresh normal
    // inside the inner loop would decorrelate the columns and silently destroy
    // the very structure the profile captured.
    const eps = new Array<number>(numeric.length).fill(0);
    for (let i = 0; i < numeric.length; i++) eps[i] = rng.normal();
    const z = new Array<number>(numeric.length).fill(0);
    if (chol.length === numeric.length) {
      for (let i = 0; i < numeric.length; i++) {
        let acc = 0;
        for (let k = 0; k <= i; k++) acc += (chol[i]?.[k] ?? 0) * (eps[k] ?? 0);
        z[i] = acc;
      }
    } else {
      for (let i = 0; i < numeric.length; i++) z[i] = eps[i] ?? 0;
    }

    profile.columns.forEach((col, idx) => {
      if (forcedNull.has(idx)) {
        row[col.name] = null;
        return;
      }

      // Null decisions are made once per group and shared by every member, so
      // co-occurring nulls agree row by row. Rolling each column separately
      // would reproduce the per-column rates while destroying the joint
      // structure, which is the part that actually matters.
      const group = groupOf.get(idx);
      let isNull: boolean;
      if (group && group.length > 1) {
        const key = groupKey(group);
        if (!groupNulls.has(key)) {
          // The group rate is its members' shared rate, approximated by the
          // strongest member so the joint frequency matches the real one.
          const rate = Math.max(...group.map((i) => profile.columns[i]?.nullRate ?? 0));
          groupNulls.set(key, rng.bool(rate));
        }
        isNull = groupNulls.get(key) === true;
      } else {
        isNull = rng.bool(col.nullRate);
      }

      if (isNull) {
        row[col.name] = null;
        return;
      }

      row[col.name] = generateValue(col, idx, profile, z, rng, redactedDicts);
    });

    rows.push(row);
  }

  const generated = profileTableFrom(profile, rows);
  return { name: profile.name, rows, profile: generated };
}

function groupKey(group: readonly number[]): string {
  return [...group].sort((a, b) => a - b).join(",");
}

function generateValue(
  col: ColumnProfile,
  idx: number,
  profile: TableProfile,
  z: readonly number[],
  rng: Rng,
  redactedDicts: ReadonlyMap<string, readonly string[]>,
): unknown {
  const dict = redactedDicts.get(col.name);
  if (dict && dict.length > 0) return rng.pick(dict);

  if (col.looksLikeIdentifier) {
    return mintIdentifier(col.name, profile.rowCount, rng);
  }

  switch (col.dtype) {
    case "int":
    case "float": {
      const numericPos = profile.numericIndices.indexOf(idx);
      const quantile = col.quantiles;
      if (!quantile) return col.dtype === "int" ? rng.int(0, 1000) : rng.normal();
      const zz = numericPos >= 0 ? (z[numericPos] ?? 0) : rng.normal();
      return sampleFromQuantiles(quantile, zz, col.dtype, rng);
    }
    case "bool":
      return rng.bool(col.trueRate ?? 0.5);
    case "date":
    case "datetime": {
      const start = Date.UTC(2020, 0, 1);
      const end = Date.UTC(2026, 0, 1);
      const t = start + rng.next() * (end - start);
      return col.dtype === "date" ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString();
    }
    case "string": {
      if (col.categories && col.categories.length > 0) {
        return weightedPick(col.categories, col.categoryWeights ?? [], rng.next());
      }
      return synthToken(col.name, rng);
    }
    default:
      return synthToken(col.name, rng);
  }
}

function mintIdentifier(colName: string, rowCount: number, rng: Rng): string {
  const suffix = rng.int(1, Math.max(2, rowCount * 4));
  return `${colName}_${suffix.toString().padStart(5, "0")}`;
}

/**
 * Builds a synthetic replacement vocabulary for a sensitive column.
 *
 * The replacements are drawn from reserved namespaces rather than invented
 * values: `example.com` for mail (RFC 2606), `555-01xx` for phone numbers, and
 * TEST-NET-3 `203.0.113.0/24` for addresses (RFC 5737). Anything else risks
 * producing a mock value that routes to, or collides with, something real.
 */
function buildDictionary(colName: string, seedValues: readonly string[], rng: Rng): string[] {
  const out = new Set<string>();
  const domain = rng.pick(SYNTHETIC_DOMAINS);
  const kind = classifySensitive(colName);
  const n = Math.max(3, Math.min(200, seedValues.length || 8));
  for (let i = 0; i < n; i++) {
    switch (kind) {
      case "email":
        out.add(`user${i}@${RESERVED_EMAIL_DOMAIN}`);
        break;
      case "phone":
        out.add(`+1-555-01${String(i).padStart(2, "0")}`);
        break;
      case "url":
        out.add(`https://${domain}/resource/${i}`);
        break;
      case "ip":
        out.add(`203.0.113.${(i % 254) + 1}`);
        break;
      case "money":
        out.add((rng.int(100, 500000) / 100).toFixed(2));
        break;
      default:
        out.add(`value_${i.toString().padStart(3, "0")}`);
    }
  }
  return [...out];
}

type SensitiveKind = "email" | "phone" | "url" | "ip" | "money" | "generic";

function classifySensitive(colName: string): SensitiveKind {
  const n = colName.toLowerCase();
  if (/mail|email/.test(n)) return "email";
  if (/phone|mobile|tel|fax/.test(n)) return "phone";
  if (/url|uri|link|host|domain|endpoint/.test(n)) return "url";
  if (/ip_?addr|^ip$/.test(n)) return "ip";
  if (/amount|price|revenue|cost|salary|balance/.test(n)) return "money";
  return "generic";
}

const TOKEN_WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
  "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo",
];

function synthToken(colName: string, rng: Rng): string {
  const stem = colName.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase() || "tok";
  const a = rng.pick(TOKEN_WORDS);
  const b = rng.pick(TOKEN_WORDS);
  const n = rng.int(0, 1000);
  return `${stem}-${a}-${b}-${n}`;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Reprofiles generated rows so callers can diff fidelity against the original. */
function profileTableFrom(original: TableProfile, rows: readonly Record<string, unknown>[]): TableProfile {
  return profileTable(original.name, rows);
}

/**
 * Replaces sensitive category vocabularies in a profile. Must be called before
 * {@link generateTable} for any column whose real values are identifying.
 */
export function redactCategories(
  profile: TableProfile,
  columns: readonly string[],
  rng: Rng,
): { profile: TableProfile; replacements: Record<string, string[]> } {
  const replacements: Record<string, string[]> = {};
  const redacted = profile.columns.map((col) => {
    if (!columns.includes(col.name)) return col;
    const dict = buildDictionary(col.name, col.categories ?? [], rng);
    replacements[col.name] = dict;
    // Uniform weights across the replacement vocabulary. The real frequency
    // distribution describes values that are being removed, so carrying it over
    // would leak a property of the data being hidden.
    return {
      ...col,
      categories: dict,
      categoryWeights: dict.map(() => round(1 / dict.length, 6)),
    };
  });
  return { profile: { ...profile, columns: redacted }, replacements };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Fidelity diff between the original profile and the generated one. */
export interface FidelityReport {
  readonly column: string;
  readonly metric: string;
  readonly expected: number;
  readonly actual: number;
  /** Relative difference, 0 when identical. */
  readonly delta: number;
  readonly ok: boolean;
}

/**
 * Relative difference between two values.
 *
 * Uses a symmetric denominator so the result is bounded to [0, 2] and does not
 * explode when the expected value is near zero. Comparing normalized copies of
 * both numbers would always report "expected 1.0", which is what an earlier
 * version did and which made the metric meaningless.
 */
function relativeDelta(expected: number, actual: number): number {
  const scale = Math.max(Math.abs(expected), Math.abs(actual));
  if (scale < 1e-12) return 0;
  return Math.abs(expected - actual) / scale;
}

export function compareProfiles(expected: TableProfile, actual: TableProfile, tolerance = 0.15): FidelityReport[] {
  const out: FidelityReport[] = [];

  const push = (column: string, metric: string, e: number, a: number, tol = tolerance): void => {
    const delta = relativeDelta(e, a);
    out.push({ column, metric, expected: e, actual: a, delta, ok: delta <= tol });
  };

  /** Absolute comparison, for metrics where a fixed difference is what matters. */
  const pushAbs = (column: string, metric: string, e: number, a: number, tol: number): void => {
    const delta = Math.abs(e - a);
    // Report the absolute delta as a fraction of the expected value, so the
    // display stays comparable across metrics without pretending an absolute
    // check used a relative scale.
    const displayDelta = Math.abs(e) > 1e-12 ? delta / Math.abs(e) : delta;
    out.push({ column, metric, expected: e, actual: a, delta: displayDelta, ok: delta <= tol });
  };

  for (const col of expected.columns) {
    const got = actual.columns.find((c) => c.name === col.name);
    if (!got) {
      out.push({ column: col.name, metric: "present", expected: 1, actual: 0, delta: 1, ok: false });
      continue;
    }
    // Identifier columns are deliberately regenerated as fresh identifiers, so
    // their type is expected to change from the real key type to a string.
    if (!col.looksLikeIdentifier && got.dtype !== col.dtype) {
      out.push({
        column: col.name,
        metric: "dtype",
        expected: dtypeRank(col.dtype),
        actual: dtypeRank(got.dtype),
        delta: 1,
        ok: false,
      });
    }
    // Missingness is judged on an absolute scale. A relative comparison makes a
    // 2.4 percentage-point error in a 9% null rate look like a 21% failure,
    // which would drown the report in noise about differences that do not matter.
    pushAbs(col.name, "nullRate", col.nullRate, got.nullRate, 0.03);

    if (col.categories && got.categories) {
      push(col.name, "cardinality", col.categories.length, got.categories.length);
      // Vocabulary closure, not identity. A generated value must come from the
      // profile's vocabulary, which is what keeps a mock self-consistent for
      // the cloud model. Demanding the same most-frequent value would fail
      // whenever the weights were flattened by redaction, which is the correct
      // behaviour rather than a defect.
      const allowed = new Set(col.categories);
      const strays = got.categories.filter((c) => !allowed.has(c));
      out.push({
        column: col.name,
        metric: "vocabulary",
        expected: col.categories.length,
        actual: strays.length,
        delta: 0,
        ok: strays.length === 0,
      });
    }

    // Quantile comparison is only meaningful when both sides describe actual
    // numeric values. For a free-text column the "quantiles" are string
    // lengths, and for a generated identifier they are lengths too, so
    // comparing them across the two sides would report noise.
    const numericExpectation = col.dtype === "int" || col.dtype === "float";
    if (numericExpectation && got.dtype === col.dtype && !col.looksLikeIdentifier) {
      if (col.quantiles && got.quantiles) {
        push(col.name, "median", col.quantiles.median, got.quantiles.median);
        push(col.name, "spread", col.quantiles.max - col.quantiles.min, got.quantiles.max - got.quantiles.min);
      }
    }
  }

  // Row count is compared absolutely; shrinking the mock is the point.
  pushAbs("*", "rowCount", expected.rowCount, actual.rowCount, Math.max(1, expected.rowCount * 0.5));
  return out;
}

function dtypeRank(dtype: string): number {
  switch (dtype) {
    case "int":
      return 1;
    case "float":
      return 2;
    case "bool":
      return 3;
    case "string":
      return 4;
    case "date":
      return 5;
    case "datetime":
      return 6;
    default:
      return 0;
  }
}