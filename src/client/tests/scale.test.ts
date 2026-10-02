/**
 * EXPANSION.md Lemma B and P4 at scale: ONE CHUNK, ONE CONTINUATION.
 *
 * The dev incident (2026-10-01): 5,000 `(system:S, parent, device:Dn)` facts
 * and one `(S, source, notification_rule:R)` were imported, then `rebuild`
 * ran. The previous engine enqueued every item a chunk spawned as its own
 * workpool cursor (hundreds per chunk), contended with the pool's own loop,
 * and lost work. Now a transaction enqueues at most one continuation, whose
 * list is bounded by the schema (Lemma B), and the expansion drains.
 *
 * Scale: convex-test walks every document of the component on each index
 * query, so its cost grows with (queries × documents). The permanent run
 * uses N = 500 at writeBudget 200 (the same chunk arithmetic, ~50
 * continuations); `ZBAR_SCALE=5000` reproduces the incident exactly
 * (N = 5,000 at writeBudget 1000; (a) alone takes about 6 minutes, measured
 * 85 continuations of a bound of 89). (d) runs 200 `(S, source, R_i)` facts
 * (1,000 under the flag) over 2 devices: the incident's 50 devices would mean
 * 50,000 derived rows, beyond what convex-test can drain.
 */
import { zbarEngineTest } from "../../test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { components, internal } from "../../component/_generated/api";
import { expansionPool } from "../../component/workpool";
import {
  type Task,
  engine,
  expectLineage,
  graphConfig,
  parked,
  rule,
  runTask,
  snapshot,
} from "./expansion-harness";

const FULL = process.env.ZBAR_SCALE === "5000";
const N = FULL ? 5000 : 500;
const B = FULL ? 1000 : 200; // writeBudget (1000 is the default)
const SOURCES = FULL ? 1000 : 200; // (d)
const DEVICES = 2; // (d)
const D = 16; // maxDepth, the default
const TIMEOUT = 3_600_000;

/**
 * EXPANSION.md §5: every continuation but the last spends at least
 * `B − 3 − D` units, so `W` units take at most `⌈W / (B − 3 − D)⌉ + 1`
 * continuations beyond the caller's transaction.
 */
const continuationBound = (units: number) => Math.ceil(units / (B - 3 - D)) + 2;

// The app's notification-source arm, as one rule: (S, source, R) is the first
// hop, the inverse fact (S, parent, Dn) the second; the row is (Dn, source, R).
const SOURCE = rule({
  objectType: "notification_rule",
  derived: "source",
  firstHop: "source",
  intermediateType: "system",
  inverses: [{ subjectType: "device", relation: "parent" }],
  target: "devices",
});
const RULES = [SOURCE];

/**
 * The budget units one `(S, parent, Dn)` fact costs over the whole rebuild
 * (EXPANSION.md §5): derive 3 (its share of a 2-entry fetch, the entry, the
 * mirror) + its add/inverse 5 (the source get, one short fetch, the entry,
 * a 2-fact path) + retire 8 (its mirror row 3, its derived row 5) = 16, and 1
 * more as an entry of R's add/first, which finds every row already there.
 */
const K = 17;

const pad = (i: number) => String(i).padStart(5, "0");
const device = (i: number) => `D${pad(i)}`;

/** Insert facts as the dev import did: `relationships` only, no mirror, no lineage. */
async function importFacts(
  t: any,
  facts: [string, string, string, string, string][],
) {
  for (let i = 0; i < facts.length; i += 2000) {
    await t.run(async (ctx: any) => {
      for (const [
        subjectType,
        subjectId,
        relation,
        objectType,
        objectId,
      ] of facts.slice(i, i + 2000)) {
        await ctx.db.insert("relationships", {
          subjectType,
          subjectId,
          relation,
          objectType,
          objectId,
        });
      }
    });
  }
}
const parentFacts = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      ["system", "S", "parent", "device", device(i)] as [
        string,
        string,
        string,
        string,
        string,
      ],
  );

/** Run the real workpool until idle (the parity suite's pump). */
async function settle(t: any, maxRounds = 20_000) {
  const diagnostics = (components as any).workpool.stats.diagnostics;
  let idle = 0;
  for (let round = 0; round < maxRounds; round++) {
    vi.advanceTimersByTime(1000);
    await t.finishInProgressScheduledFunctions();
    const d = await t.query(diagnostics, {});
    idle =
      d.waiting + d.running + d.completing + d.canceling === 0 ? idle + 1 : 0;
    if (idle >= 2) return;
  }
  throw new Error(`the workpool did not drain within ${maxRounds} rounds`);
}

/**
 * Run parked cursors (mock workpool) until none is left, asserting that at
 * every point at most one is parked (one chain, one continuation per chunk).
 * Returns the number of chunks run and the longest list seen.
 */
async function drainOne(t: any) {
  let chunks = 0;
  let longest = 0;
  for (
    let tasks: Task[] = await parked(t);
    tasks.length > 0;
    tasks = await parked(t)
  ) {
    expect(tasks).toHaveLength(1);
    longest = Math.max(longest, tasks[0].args.items.length);
    await runTask(t, tasks[0]);
    chunks++;
  }
  return { chunks, longest };
}

/** The end state of the scenario: N derived rows, a mirror per fact, L exact, no failure. */
async function expectDrained(t: any, n: number, rules: number) {
  const { facts, rows, lineage, failures } = await snapshot(t);
  const derived = rows.filter(
    (r: any) => r.relation === "source" && r.subjectKey.startsWith("device:"),
  );
  expect(derived).toHaveLength(n * rules);
  for (const r of derived)
    expect(r.paths.map((p: any) => p.baseIds.length)).toEqual([2]);
  const mirrored = new Set(
    rows.flatMap((r: any) =>
      r.paths
        .filter((p: any) => p.rule === "fact")
        .map((p: any) => p.baseIds[0]),
    ),
  );
  for (const f of facts) expect(mirrored.has(f.id)).toBe(true);
  expect(rows).toHaveLength(facts.length + n * rules);
  // lineage = Σ paths × facts: one per mirror, two per derived row.
  expect(lineage).toHaveLength(facts.length + 2 * n * rules);
  expect(failures).toEqual([]);
  await expectLineage(t);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe(`one chunk, one continuation (N = ${N}, writeBudget ${B})`, () => {
  test(
    "(a) rebuild over N imported parent facts and one source fact drains under the real workpool",
    async () => {
      const t = zbarEngineTest();
      await importFacts(t, [
        ...parentFacts(N),
        ["system", "S", "source", "notification_rule", "R"],
      ]);
      const enqueue = vi.spyOn(expansionPool, "enqueueMutation");

      await engine(
        t,
        graphConfig(RULES, { writeBudget: B, mock: false }),
        "scale",
      ).rebuild();
      expect(enqueue).toHaveBeenCalledTimes(1); // the caller's transaction: one continuation
      await settle(t);

      await expectDrained(t, N, 1);
      // Every enqueue is one continueExpansion execution (none failed, so none
      // was a retry): about K·N / B.
      const continuations = enqueue.mock.calls.length;
      const bound = continuationBound((N + 1) * K);
      console.info(
        `(a) N=${N}: ${continuations} continuations (bound ${bound})`,
      );
      expect(continuations).toBeLessThanOrEqual(bound);
      // Lemma B: no payload grew with N (≤ 1 scan item + 3|rules| + (D−1)|rules|).
      const longest = Math.max(
        ...enqueue.mock.calls.map((c) => (c[2] as any).items.length),
      );
      expect(longest).toBeLessThanOrEqual(3 * RULES.length + 17);
    },
    TIMEOUT,
  );

  describe("(b) addRelation over N existing parent facts, then (c) deleteEntity", () => {
    const t = zbarEngineTest();
    const z = engine(
      t,
      graphConfig(RULES, { writeBudget: B, mock: true }),
      "scale-mock",
    );

    test(
      "(b) the caller writes ≤ B rows and parks ONE continuation; the drain ends in the same state as (a)",
      async () => {
        await importFacts(t, parentFacts(N));
        await z.rebuild(); // mirrors only: no source fact yet
        await drainOne(t);
        expect((await snapshot(t)).rows).toHaveLength(N);

        await z.add("system:S", "source", "notification_rule:R");
        const derivedInline = (await snapshot(t)).rows.filter(
          (r: any) =>
            r.relation === "source" && r.subjectKey.startsWith("device:"),
        );
        expect(derivedInline.length).toBeGreaterThan(0);
        expect(derivedInline.length).toBeLessThanOrEqual(B);
        expect(await parked(t)).toHaveLength(1);

        const { chunks } = await drainOne(t);
        console.info(
          `(b) N=${N}: ${derivedInline.length} rows inline, ${chunks} continuations`,
        );
        expect(chunks).toBeLessThanOrEqual(continuationBound(N * 3)); // 3 units per derived row
        await expectDrained(t, N, 1);
      },
      TIMEOUT,
    );

    test(
      "(c) deleteEntity(system:S) removes every fact, mirror, derived row and lineage row, one continuation per chunk",
      async () => {
        const removed = await z.deleteEntity("system:S");
        expect(removed.relationshipsRemoved).toBeGreaterThan(0);
        expect(await parked(t)).toHaveLength(1);
        const { chunks, longest } = await drainOne(t);
        console.info(
          `(c) N=${N}: ${chunks} continuations, longest list ${longest}`,
        );
        const { facts, rows, lineage, failures } = await snapshot(t);
        expect(facts).toEqual([]);
        expect(rows).toEqual([]);
        expect(lineage).toEqual([]);
        expect(failures).toEqual([]);
      },
      TIMEOUT,
    );
  });

  test(
    `(d) ${SOURCES} source facts over ${DEVICES} devices: the rebuild payload stays within the schema bound`,
    async () => {
      const t = zbarEngineTest();
      const R = SOURCES;
      await importFacts(t, [
        ...parentFacts(DEVICES),
        ...Array.from(
          { length: R },
          (_, i) =>
            ["system", "S", "source", "notification_rule", `R${pad(i)}`] as [
              string,
              string,
              string,
              string,
              string,
            ],
        ),
      ]);
      await engine(
        t,
        graphConfig(RULES, { writeBudget: B, mock: true }),
        "scale-rules",
      ).rebuild();
      const { chunks, longest } = await drainOne(t);
      console.info(
        `(d) R=${R}: ${chunks} continuations, longest list ${longest}`,
      );
      expect(longest).toBeLessThanOrEqual(3 * RULES.length + 17);
      await expectDrained(t, DEVICES, R);
    },
    TIMEOUT,
  );
});

describe("stale continuation shapes (a previous engine version) never crash the pool", () => {
  test("an unreadable payload and an unrecognized item are dropped; the old { item } envelope still runs", async () => {
    const t = zbarEngineTest();
    const z = engine(t, graphConfig(RULES), "stale");
    await z.add("system:S", "parent", "device:D1"); // registers and activates the config
    await importFacts(t, [["system", "S", "source", "notification_rule", "R"]]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await t.mutation(internal.mutations.continueExpansion, { foo: 1 });
    // An add/second of the previous version: no `paths`.
    const oldSecond = {
      kind: "add",
      trigger: "second",
      row: {
        subjectKey: "device:D1",
        relation: "parent",
        objectKey: "system:S",
      },
      rule: SOURCE.key,
      after: null,
    };
    await t.mutation(internal.mutations.continueExpansion, {
      item: oldSecond,
      configHash: "stale",
      budget: B,
      attempts: 0,
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(await parked(t)).toEqual([]);
    expect(
      (await snapshot(t)).rows.some((r: any) => r.relation === "source"),
    ).toBe(false);

    // The previous envelope around a current item: read as { items: [item] }.
    await t.mutation(internal.mutations.continueExpansion, {
      item: { kind: "rebuild", phase: "derive", after: null },
      configHash: "stale",
      budget: B,
      attempts: 0,
    });
    await expectDrained(t, 1, 1);
  });
});
