import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { profileTable, summarizeProfile, inferDtype } from "../src/profile/profile.js";
import { generateTable, redactCategories, compareProfiles, Rng, cholesky } from "../src/mock/generate.js";
import { parseDelimited, serializeDelimited } from "../src/io/load.js";

/** A dataset with the shape the user described: correlated columns and
 *  missingness that co-occurs rather than being independent. */
function realisticRows(n = 400): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const regions = ["emea", "apac", "amer"];
  const tiers = ["free", "pro", "enterprise"];
  const rng = new Rng(42);
  for (let i = 0; i < n; i++) {
    const region = regions[i % 3] as string;
    const tier = tiers[i % 3] as string;
    const tenure = 1 + (i % 60);
    // tenure correlates with amount; churn is a function of tenure.
    const amount = Math.round(tenure * 12.5 + (i % 17) * 3);
    const row: Record<string, unknown> = {
      account_id: `acc_${String(i).padStart(5, "0")}`,
      region,
      tier,
      tenure_months: tenure,
      monthly_amount: amount,
      is_active: i % 7 !== 0,
      signup_date: `2024-0${(i % 9) + 1}-1${i % 9}`,
    };
    // Missingness co-occurs: when churn_score is missing, support_tier is too.
    if (i % 11 === 0) {
      row.churn_score = null;
      row.support_tier = null;
    } else if (i % 13 === 0) {
      row.churn_score = null;
    } else {
      // churn_score correlates with tenure so it is not degenerate.
      row.churn_score = Math.round(((60 - tenure) / 60) * 100) / 100;
      row.support_tier = tier;
    }
    if (i % 23 === 0) row.monthly_amount = null;
    void rng;
    rows.push(row);
  }
  return rows;
}

describe("inferDtype", () => {
  it("distinguishes the main types", () => {
    assert.equal(inferDtype([1, 2, 3]), "int");
    assert.equal(inferDtype([1.5, 2]), "float");
    assert.equal(inferDtype([true, false]), "bool");
    assert.equal(inferDtype(["a", "b"]), "string");
    assert.equal(inferDtype(["2024-01-01"]), "datetime");
    assert.equal(inferDtype([null, 1, 3]), "int");
  });
});

describe("profileTable", () => {
  const rows = realisticRows();
  const profile = profileTable("accounts", rows);

  it("captures every column", () => {
    assert.equal(profile.columns.length, Object.keys(rows[0] ?? {}).length);
    assert.equal(profile.rowCount, rows.length);
  });

  it("computes per-column null rates", () => {
    const churn = profile.columns.find((c) => c.name === "churn_score");
    assert.ok(churn);
    // 400 rows, i%11==0 gives 37, plus i%13 but not i%11 gives extra.
    assert.ok(churn.nullRate > 0.05 && churn.nullRate < 0.2, `nullRate=${churn.nullRate}`);
  });

  it("groups columns whose nulls co-occur", () => {
    const groups = profile.nullGroups;
    const hasPair = groups.some((g) => g.length >= 2);
    assert.ok(hasPair, `expected a co-occurring group, got ${JSON.stringify(groups)}`);
  });

  it("keeps a small category vocabulary but not a large one", () => {
    const region = profile.columns.find((c) => c.name === "region");
    assert.equal(region?.dtype, "string");
    assert.equal(region?.categories?.length, 3);
  });

  it("flags identifier-like columns", () => {
    assert.equal(profile.columns.find((c) => c.name === "account_id")?.looksLikeIdentifier, true);
    assert.equal(profile.columns.find((c) => c.name === "region")?.looksLikeIdentifier, false);
  });

  it("captures numeric correlations", () => {
    const iT = profile.columns.findIndex((c) => c.name === "tenure_months");
    const iA = profile.columns.findIndex((c) => c.name === "monthly_amount");
    const ti = profile.numericIndices.indexOf(iT);
    const ai = profile.numericIndices.indexOf(iA);
    assert.ok(ti >= 0 && ai >= 0);
    const corr = profile.correlation[ti]?.[ai] ?? 0;
    assert.ok(corr > 0.7, `expected strong positive correlation, got ${corr}`);
  });

  it("never retains real values from a high-cardinality column", () => {
    const profile2 = profileTable("t", Array.from({ length: 50 }, (_, i) => ({
      note: `private customer note number ${i}`,
      id: i,
    })));
    const note = profile2.columns.find((c) => c.name === "note");
    assert.equal(note?.categories, undefined, "free text must not become a vocabulary");
  });

  it("summarizes readably", () => {
    const text = summarizeProfile(profile);
    assert.match(text, /accounts: 400 rows/);
    assert.match(text, /region/);
  });
});

describe("generateTable", () => {
  const rows = realisticRows();
  const profile = profileTable("accounts", rows);
  const generated = generateTable(profile, { rows: 200, seed: 7 });

  it("produces the requested row count", () => {
    assert.equal(generated.rows.length, 200);
  });

  it("preserves column names and order", () => {
    assert.deepEqual(Object.keys(generated.rows[0] ?? {}), Object.keys(rows[0] ?? {}));
  });

  it("preserves null rates within tolerance", () => {
    for (const col of profile.columns) {
      const got = generated.profile.columns.find((c) => c.name === col.name);
      assert.ok(got, `missing column ${col.name}`);
      const delta = Math.abs(got.nullRate - col.nullRate);
      assert.ok(delta < 0.06, `${col.name} nullRate drifted: ${col.nullRate} -> ${got.nullRate}`);
    }
  });

  it("reproduces the co-occurring null structure", () => {
    // Rows where churn_score is null should also null support_tier, far more
    // often than independent nulling would produce.
    let both = 0;
    let churnOnly = 0;
    for (const r of generated.rows) {
      const churnNull = r.churn_score === null;
      const tierNull = r.support_tier === null;
      if (churnNull && tierNull) both += 1;
      else if (churnNull && !tierNull) churnOnly += 1;
    }
    assert.ok(churnOnly === 0 || both >= churnOnly, `co-occurrence lost: both=${both} churnOnly=${churnOnly}`);
  });

  it("preserves category vocabulary", () => {
    const region = generated.rows.map((r) => r.region);
    assert.deepEqual([...new Set(region)].sort(), ["amer", "apac", "emea"]);
  });

  it("preserves the numeric correlation", () => {
    const g = generated.profile;
    const iT = g.columns.findIndex((c) => c.name === "tenure_months");
    const iA = g.columns.findIndex((c) => c.name === "monthly_amount");
    const corr = g.correlation[g.numericIndices.indexOf(iT)]?.[g.numericIndices.indexOf(iA)] ?? 0;
    assert.ok(corr > 0.5, `correlation dropped to ${corr}`);
  });

  it("mints fresh identifiers rather than reusing real ones", () => {
    const realIds = new Set(rows.map((r) => String(r.account_id)));
    for (const r of generated.rows) {
      assert.ok(!realIds.has(String(r.account_id)), `reused real id ${r.account_id}`);
    }
  });

  it("does not reproduce real values from a wide continuous column", () => {
    // A wide-range float column is where verbatim reproduction would actually
    // leak information. A low-cardinality integer column like `tenure_months`
    // legitimately repeats values, so it is not the right subject for this test.
    const wide = Array.from({ length: 500 }, (_, i) => ({
      account_id: `acc_${i}`,
      score: Math.round((i * 37.1237 + i * i * 0.913) % 98765.4321 * 1000) / 1000,
    }));
    const wideProfile = profileTable("wide", wide);
    const wideGen = generateTable(wideProfile, { rows: 200, seed: 3 });
    const real = new Set(wide.map((r) => String(r.score)));
    const collisions = wideGen.rows.filter((r) => real.has(String(r.score)));
    // A handful of coincidences are unavoidable when the generator clamps to the
    // observed [min, max] range and the real column contains its own extremes.
    // Systematic copying would show up as a large share, not a tiny one.
    assert.ok(
      collisions.length < wideGen.rows.length * 0.03,
      `${collisions.length}/${wideGen.rows.length} verbatim values leaked`,
    );
  });

  it("keeps generated values inside the observed range", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: i,
      score: Math.min(1, Math.max(0, (i % 50) / 50)),
    }));
    const p = profileTable("bounded", rows);
    const g = generateTable(p, { rows: 200, seed: 5 });
    const lo = Math.min(...rows.map((r) => r.score as number));
    const hi = Math.max(...rows.map((r) => r.score as number));
    for (const r of g.rows) {
      const score = r.score as number | null;
      assert.ok(score === null || (score >= lo && score <= hi), `out of range: ${String(score)}`);
    }
  });

  it("is reproducible for a given seed", () => {
    const a = generateTable(profile, { rows: 50, seed: 99 });
    const b = generateTable(profile, { rows: 50, seed: 99 });
    assert.deepEqual(a.rows, b.rows);
  });

  it("differs for a different seed", () => {
    const a = generateTable(profile, { rows: 50, seed: 1 });
    const b = generateTable(profile, { rows: 50, seed: 2 });
    assert.notDeepEqual(a.rows, b.rows);
  });

  it("scores well on fidelity", () => {
    const report = compareProfiles(profile, generated.profile, 0.15);
    const ok = report.filter((r) => r.ok).length;
    assert.ok(ok / report.length > 0.8, `fidelity ${ok}/${report.length}`);
  });
});

describe("redactCategories", () => {
  it("replaces a sensitive vocabulary and keeps it out of the output", () => {
    const rows = [
      { email: "alice@acme.com", region: "emea" },
      { email: "bob@acme.com", region: "emea" },
      { email: "carol@acme.com", region: "emea" },
      { email: "dave@acme.com", region: "emea" },
      { email: "erin@acme.com", region: "emea" },
      { email: "frank@acme.com", region: "emea" },
    ];
    const profile = profileTable("t", rows);
    const { profile: safe } = redactCategories(profile, ["email"], new Rng(1));
    const generated = generateTable(safe, { rows: 20, seed: 1 });
    const json = JSON.stringify(generated.rows);
    assert.ok(!json.includes("acme.com"), "real email domain leaked into the mock");
    assert.ok(json.includes("example.com"));
    // Unrelated columns are untouched.
    assert.ok(generated.rows.every((r) => r.region === "emea"));
  });
});

describe("heterogeneous records", () => {
  it("profiles the union of keys, not just the first row's", () => {
    const rows = [
      { id: 1, name: "a" },
      { id: 2, name: "b", extra: "late field" },
      { id: 3, name: "c", extra: "another" },
    ];
    const profile = profileTable("t", rows);
    const names = profile.columns.map((c) => c.name);
    assert.deepEqual(names, ["id", "name", "extra"], "the late-arriving column was dropped");
  });

  it("treats an absent key as null for the rows that lack it", () => {
    const rows = [{ id: 1, extra: "x" }, { id: 2 }, { id: 3 }];
    const profile = profileTable("t", rows);
    const extra = profile.columns.find((c) => c.name === "extra");
    assert.ok(Math.abs((extra?.nullRate ?? 0) - 2 / 3) < 1e-6, `nullRate=${extra?.nullRate}`);
  });
});

describe("cholesky", () => {
  it("factorizes the identity", () => {
    const l = cholesky([[1, 0], [0, 1]]);
    assert.ok(Math.abs(l[0]![0]! - 1) < 1e-6);
    assert.ok(Math.abs(l[1]![1]! - 1) < 1e-6);
  });
});

describe("delimited io", () => {
  it("parses quoted fields with embedded delimiters and newlines", () => {
    const text = 'a,b,c\n1,"x,y",3\n2,"line1\nline2",4\n';
    const rows = parseDelimited(text, ",");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.b, "x,y");
    assert.equal(rows[1]?.b, "line1\nline2");
  });

  it("parses escaped quotes", () => {
    const rows = parseDelimited('a\n"he said ""hi"""\n', ",");
    assert.equal(rows[0]?.a, 'he said "hi"');
  });

  it("round-trips through serialization", () => {
    const rows = [
      { a: 1, b: "x,y", c: null },
      { a: 2, b: 'q"z', c: true },
    ];
    const back = parseDelimited(serializeDelimited(rows, ","), ",");
    assert.equal(back.length, 2);
    assert.equal(back[0]?.b, "x,y");
    assert.equal(back[1]?.b, 'q"z');
    assert.equal(back[0]?.c, null);
    assert.equal(back[1]?.c, true);
  });
});