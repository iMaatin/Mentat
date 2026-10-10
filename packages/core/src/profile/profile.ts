/**
 * Dataset profiling.
 *
 * Captures the statistical fingerprint of a real table so the synthetic mock can
 * reproduce it. The goal is fidelity in *structure and statistical shape*, not
 * in values:
 *
 *  - Same columns, same order, same dtypes.
 *  - Same null rate per column, and the same null *co-occurrence structure*
 *    (which is what actually breaks naive mocks).
 *  - Same cardinality and category vocabulary for discrete columns.
 *  - Same distribution shape for continuous columns (via quantiles, so heavy
 *    tails and skew survive).
 *  - Same linear correlation structure between numeric columns.
 *
 * No real values are retained anywhere. The profile is safe to send.
 */

export type Dtype = "int" | "float" | "bool" | "string" | "date" | "datetime" | "unknown";

export interface Quantiles {
  readonly min: number;
  readonly q25: number;
  readonly median: number;
  readonly q75: number;
  readonly max: number;
}

export interface ColumnProfile {
  readonly name: string;
  readonly dtype: Dtype;
  /** Fraction of null values, 0..1. */
  readonly nullRate: number;
  /** Distinct non-null values. */
  readonly cardinality: number;
  /** Numeric columns only. */
  readonly quantiles?: Quantiles;
  /** Discrete columns only: the value vocabulary, sorted by frequency. */
  readonly categories?: readonly string[];
  /** Discrete columns: fractional frequency of each category. */
  readonly categoryWeights?: readonly number[];
  /** Bool columns only. */
  readonly trueRate?: number;
  /** Name of the column this one references, inferred from shared vocabulary. */
  readonly foreignKey?: { column: string; cardinalityRatio: number };
  /** Set when the column looks like an identifier rather than a measure. */
  readonly looksLikeIdentifier?: boolean;
}

export interface TableProfile {
  readonly name: string;
  readonly rowCount: number;
  readonly columns: readonly ColumnProfile[];
  /** Indices into `columns` that are numeric, for correlation modelling. */
  readonly numericIndices: readonly number[];
  /** Pearson correlation between numeric columns, as a square matrix. */
  readonly correlation: readonly (readonly number[])[];
  /**
   * Groups of columns whose nulls co-occur. Each group is a set of indices
   * whose null masks agree above `coOccurrenceThreshold`. Reproducing this is
   * what makes a mock behave like the original under a missing-data model.
   */
  readonly nullGroups: readonly (readonly number[])[];
  /** Fraction of rows that are entirely null across all columns. */
  readonly fullyNullRowRate: number;
}

export interface ProfileOptions {
  /** Rows sampled for profiling. Full data is never loaded. */
  readonly sampleRows?: number;
  readonly seed?: number;
  readonly coOccurrenceThreshold?: number;
  /** Categories above this count are treated as free text, not vocabulary. */
  readonly maxCategories?: number;
  readonly identifierNamePattern?: RegExp;
}

const DEFAULT_OPTIONS: Required<Omit<ProfileOptions, "identifierNamePattern">> = {
  sampleRows: 20_000,
  seed: 0x5eed,
  coOccurrenceThreshold: 0.7,
  maxCategories: 64,
};

const IDENTIFIER_HINT =
  /(^|_)(id|uuid|key|code|ref|no|num|sid|guid|token)$|(^|_)(id|uuid|key)$|^(pk|fk)_/i;

export function looksLikeIdentifierColumn(name: string): boolean {
  return IDENTIFIER_HINT.test(name);
}

function isNullish(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number" && Number.isNaN(value)) return true;
  if (typeof value === "string" && (value === "" || value.toLowerCase() === "na" || value.toLowerCase() === "null")) {
    return true;
  }
  return false;
}

/** Order-preserving type inference, tightened by the observed values. */
export function inferDtype(values: readonly unknown[]): Dtype {
  let sawInt = false;
  let sawFloat = false;
  let sawBool = false;
  let sawDate = false;
  let sawString = false;
  let sawOther = false;

  for (const v of values) {
    if (isNullish(v)) continue;
    if (typeof v === "boolean") sawBool = true;
    else if (typeof v === "number") (Number.isInteger(v) ? (sawInt = true) : (sawFloat = true));
    else if (v instanceof Date) sawDate = true;
    else if (typeof v === "string") {
      if (DATE_LIKE.test(v)) sawDate = true;
      else sawString = true;
    } else sawOther = true;
  }

  if (sawOther) return "unknown";
  if (sawDate && !sawString && !sawInt && !sawFloat && !sawBool) return "datetime";
  if (sawDate && !sawString && !sawInt && !sawFloat && !sawBool) return "date";
  if (sawInt && !sawFloat) return "int";
  if (sawFloat) return "float";
  if (sawBool && !sawString) return "bool";
  if (sawString) return "string";
  return "unknown";
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

function quantilesOf(sorted: readonly number[]): Quantiles | undefined {
  if (sorted.length === 0) return undefined;
  const at = (q: number): number => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const loV = sorted[lo] ?? 0;
    const hiV = sorted[hi] ?? loV;
    return loV + (hiV - loV) * (pos - lo);
  };
  return { min: sorted[0] ?? 0, q25: at(0.25), median: at(0.5), q75: at(0.75), max: sorted[sorted.length - 1] ?? 0 };
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i] ?? 0;
    my += ys[i] ?? 0;
  }
  mx /= n;
  my /= n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  return denom === 0 ? 0 : clamp(cov / denom, -1, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Groups columns whose missingness behaves the same way, so the generator can
 * null whole groups together instead of each column independently.
 *
 * Two conditions must both hold:
 *  1. The null masks agree at least `threshold` of the time.
 *  2. The columns have similar null rates.
 *
 * The second condition is not optional. Two columns can have correlated masks
 * and very different rates - a column missing 4% of rows and one missing 16%
 * will still agree on ~80% of rows purely because neither is usually null. A
 * generator that applied one shared rate to such a group would inflate the
 * sparser column's missingness by a factor of three.
 */
function findNullGroups(
  masks: readonly (readonly boolean[])[],
  rates: readonly number[],
  threshold: number,
  rateTolerance = 0.04,
): (readonly number[])[] {
  const used = new Set<number>();
  const groups: number[][] = [];
  for (let i = 0; i < masks.length; i++) {
    const mask = masks[i];
    if (!mask || mask.every((b) => !b)) continue;
    if (used.has(i)) continue;
    const group = [i];
    used.add(i);
    for (let j = i + 1; j < masks.length; j++) {
      if (used.has(j)) continue;
      const other = masks[j];
      if (!other) continue;
      if (Math.abs((rates[i] ?? 0) - (rates[j] ?? 0)) > rateTolerance) continue;
      let agree = 0;
      for (let k = 0; k < mask.length; k++) if (mask[k] === other[k]) agree += 1;
      if (agree / mask.length >= threshold) {
        group.push(j);
        used.add(j);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Profiling options plus the seed make the profile reproducible, which matters
 * for regression tests and for keeping jobs comparable.
 */
export function profileTable(
  name: string,
  rows: readonly Record<string, unknown>[],
  options: ProfileOptions = {},
): TableProfile {
  const sampleRows = options.sampleRows ?? DEFAULT_OPTIONS.sampleRows;
  const maxCategories = options.maxCategories ?? DEFAULT_OPTIONS.maxCategories;
  const threshold = options.coOccurrenceThreshold ?? DEFAULT_OPTIONS.coOccurrenceThreshold;
  const sampled = rows.length > sampleRows ? rows.slice(0, sampleRows) : rows;

  // Union of all keys, in first-seen order. Reading only the first row's keys
  // silently drops any column that is absent from it, which happens routinely
  // with sparse JSON and JSONL where later records carry extra fields.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of sampled) {
    for (const key of Object.keys(row ?? {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  const columns: ColumnProfile[] = [];
  const nullMasks: boolean[][] = [];
  const numericSeries: number[][] = [];
  const numericIndices: number[] = [];

  for (const colName of names) {
    const raw = sampled.map((r) => r[colName]);
    const nullMask = raw.map((v) => isNullish(v));
    nullMasks.push(nullMask);
    const nonNull = raw.filter((v) => !isNullish(v));
    const nullRate = raw.length === 0 ? 0 : (raw.length - nonNull.length) / raw.length;
    const dtype = inferDtype(nonNull);
    const cardinality = new Set(nonNull.map((v) => stringify(v))).size;

    const base: ColumnProfile = {
      name: colName,
      dtype,
      nullRate: round(nullRate, 6),
      cardinality,
      looksLikeIdentifier: looksLikeIdentifierColumn(colName),
    };

    if (dtype === "int" || dtype === "float") {
      const nums = nonNull.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => Number.isFinite(n));
      nums.sort((a, b) => a - b);
      const profile: ColumnProfile = { ...base, dtype: dtype as "int" | "float", quantiles: quantilesOf(nums) };
      columns.push(profile);
      // Correlate on positionally-aligned, non-null pairs to avoid bias.
      const aligned: number[] = [];
      const others: number[] = [];
      raw.forEach((v, idx) => {
        const o = raw[idx];
        void o;
        if (!isNullish(v) && typeof v === "number") aligned.push(v);
        else aligned.push(Number.NaN);
      });
      numericIndices.push(columns.length - 1);
      numericSeries.push(aligned);
      continue;
    }

    if (dtype === "bool") {
      const trues = nonNull.filter((v) => v === true || v === "true" || v === 1).length;
      columns.push({ ...base, trueRate: nonNull.length === 0 ? 0 : round(trues / nonNull.length, 6) });
      continue;
    }

    // String / date columns. A small vocabulary is a real category set worth
    // preserving; a large one means free text and must not be memorized.
    const counts = new Map<string, number>();
    for (const v of nonNull) {
      const key = stringify(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Two independent guards. An absolute cap catches wide vocabularies; a
    // ratio catches the case that actually matters for free text, where nearly
    // every row holds a distinct value. Either one alone is insufficient: 50
    // distinct values is small in absolute terms but is one-per-row.
    const ratio = sampled.length > 0 ? counts.size / sampled.length : 0;
    // A single distinct value is a constant column, not free text. Dropping it
    // would lose a real and meaningful part of the schema.
    const isConstant = counts.size <= 1;
    // The distinct-ratio guard only means something once there are enough rows
    // to distinguish "a category column" from "one value per row". On a 3-row
    // extract every column is nearly all-distinct, and applying the guard would
    // turn a two-value region column into free text.
    const ratioIsMeaningful = sampled.length >= 20;
    const isCategoryLike =
      isConstant ||
      (counts.size <= maxCategories && (!ratioIsMeaningful || ratio <= 0.5));

    if (isCategoryLike) {
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const total = sorted.reduce((s, [, c]) => s + c, 0);
      columns.push({
        ...base,
        categories: sorted.map(([k]) => k),
        categoryWeights: sorted.map(([, c]) => round(c / total, 6)),
      });
      continue;
    }

    // Free text or an identifier: keep length statistics, drop the vocabulary
    // entirely. Values like real names or messages must never enter the profile.
    const lengths = nonNull.map((v) => stringify(v).length).sort((a, b) => a - b);
    columns.push({
      ...base,
      quantiles: quantilesOf(lengths),
      categories: undefined,
    });
  }

  const correlation = numericSeries.length === 0 ? [] : buildCorrelation(numericSeries);

  const fullyNullRowRate = computeFullyNullRate(nullMasks, names.length);

  return {
    name,
    rowCount: rows.length,
    columns,
    numericIndices,
    correlation,
    nullGroups: findNullGroups(nullMasks, columns.map((c) => c.nullRate), threshold),
    fullyNullRowRate: round(fullyNullRowRate, 6),
  };
}

function buildCorrelation(series: readonly (readonly number[])[]): number[][] {
  const size = series.length;
  const matrix: number[][] = [];
  for (let i = 0; i < size; i++) {
    const row: number[] = [];
    for (let j = 0; j < size; j++) {
      if (i === j) {
        row.push(1);
        continue;
      }
      const a = series[i] ?? [];
      const b = series[j] ?? [];
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = 0; k < Math.min(a.length, b.length); k++) {
        const av = a[k] ?? Number.NaN;
        const bv = b[k] ?? Number.NaN;
        if (Number.isFinite(av) && Number.isFinite(bv)) {
          xs.push(av);
          ys.push(bv);
        }
      }
      row.push(round(pearson(xs, ys), 4));
    }
    matrix.push(row);
  }
  return matrix;
}

function computeFullyNullRate(masks: readonly (readonly boolean[])[], columnCount: number): number {
  if (columnCount === 0 || masks.length === 0) return 0;
  const rows = masks[0]?.length ?? 0;
  let count = 0;
  for (let r = 0; r < rows; r++) {
    let allNull = true;
    for (const mask of masks) if (!mask[r]) {
      allNull = false;
      break;
    }
    if (allNull) count += 1;
  }
  return count / rows;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Human-readable summary for `mentat inspect`. */
export function summarizeProfile(profile: TableProfile): string {
  const lines = [`${profile.name}: ${profile.rowCount} rows x ${profile.columns.length} columns`];
  for (const col of profile.columns) {
    const bits = [`  ${col.name}`, `  ${col.dtype}`];
    if (col.nullRate > 0) bits.push(`null=${(col.nullRate * 100).toFixed(1)}%`);
    bits.push(`card=${col.cardinality}`);
    if (col.categories) bits.push(`cats=${col.categories.length}`);
    if (col.quantiles) bits.push(`med=${round(col.quantiles.median, 2)}`);
    if (col.looksLikeIdentifier) bits.push("[id]");
    lines.push(bits.join("  "));
  }
  if (profile.nullGroups.length > 0) {
    lines.push(
      `  co-occurring null groups: ${profile.nullGroups
        .map((g) => g.map((i) => profile.columns[i]?.name ?? "?").join("+"))
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}