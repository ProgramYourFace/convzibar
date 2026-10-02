/**
 * EXPANSION.md P3 (removal soundness), and the invariants that make removal
 * by lineage complete whatever the interleaving and whatever config wrote
 * the paths: W (a path is written only by a transaction that read all its
 * facts present) and L (`lineage` names every fact of every stored path).
 */
import { zbarEngineTest } from "../../test";
import { describe, expect, test } from "vitest";
import {
  ALL_RULES,
  MANAGE,
  ORG,
  TEAM,
  type Task,
  discardRebuilds,
  drain,
  engine,
  expectExact,
  expectLineage,
  graphConfig,
  parked,
  runTask,
  snapshot,
} from "./expansion-harness";

const fifo = () => 0;
const lifo = (ts: Task[]) => ts.length - 1;
const removalsFirst = (ts: Task[]) =>
  Math.max(
    0,
    ts.findIndex((x) => x.args.items[0].kind === "remove"),
  );
const additionsFirst = (ts: Task[]) =>
  Math.max(
    0,
    ts.findIndex((x) => x.args.items[0].kind === "add"),
  );
const ORDERS = { fifo, lifo, removalsFirst, additionsFirst };

/** P3: no path names the removed fact, and every row keeps a path of live facts. */
async function expectRemoved(t: any, factId: string) {
  const { rows, facts } = await snapshot(t);
  const live = new Set(facts.map((f: any) => f.id));
  for (const row of rows) {
    for (const p of row.paths) expect(p.baseIds).not.toContain(factId);
    expect(
      row.paths.some((p: any) => p.baseIds.every((id: string) => live.has(id))),
    ).toBe(true);
  }
}

describe("P3 removal soundness", () => {
  test("removing the first link of a chain retracts every row derived through it", async () => {
    const t = zbarEngineTest();
    const z = engine(t, graphConfig([TEAM, ORG], { writeBudget: 2 }));
    const a = await z.add("user:u", "member", "squad:s");
    await z.add("squad:s", "member", "team:t");
    await z.add("team:t", "viewer", "org:o");
    await drain(t);
    expect(
      (await snapshot(t)).rows.some(
        (r: any) => r.subjectKey === "user:u" && r.relation === "viewer",
      ),
    ).toBe(true);

    await z.remove("user:u", "member", "squad:s");
    await drain(t);
    await expectRemoved(t, a);
    await expectExact(t, [TEAM, ORG], 16);
    expect(
      (await snapshot(t)).rows.some((r: any) => r.subjectKey === "user:u"),
    ).toBe(false);
  });

  test("a row reachable by two lineages survives the removal of one, and goes with the second", async () => {
    const t = zbarEngineTest();
    const z = engine(t, graphConfig([TEAM, ORG], { writeBudget: 2 }));
    const a1 = await z.add("user:u", "member", "squad:s1");
    const a2 = await z.add("user:u", "member", "squad:s2");
    await z.add("squad:s1", "member", "team:t");
    await z.add("squad:s2", "member", "team:t");
    await z.add("team:t", "viewer", "org:o");
    await drain(t);
    const viewer = (rows: any[]) =>
      rows.find(
        (r) =>
          r.subjectKey === "user:u" &&
          r.relation === "viewer" &&
          r.objectKey === "org:o",
      );
    expect(viewer((await snapshot(t)).rows).paths).toHaveLength(2);

    await z.remove("user:u", "member", "squad:s1");
    await drain(t);
    await expectRemoved(t, a1);
    expect(viewer((await snapshot(t)).rows).paths).toHaveLength(1);
    await expectExact(t, [TEAM, ORG], 16);

    await z.remove("user:u", "member", "squad:s2");
    await drain(t);
    await expectRemoved(t, a2);
    expect(viewer((await snapshot(t)).rows)).toBeUndefined();
  });
});

/** Every stored path that names `factId`, as `rowId/pathId` strings. */
async function pathsNaming(t: any, factId: string): Promise<Set<string>> {
  const { rows } = await snapshot(t);
  const out = new Set<string>();
  for (const r of rows) {
    for (const p of r.paths)
      if (p.baseIds.includes(factId))
        out.add(`${r._id}/${p.baseIds.join(",")}/${p.rule}`);
  }
  return out;
}

describe("Invariant W: no path naming a deleted fact is written after its deletion", () => {
  // u manages g1 (and a, sorted before u, too); g1 → g2 → g3 → g4 by parent.
  // Removing g1→g2 while u's walk is parked mid-flight leaves add cursors
  // whose source rows still hold paths through g1→g2. Whatever runs first,
  // the set of stored paths naming g1→g2 only shrinks from the moment it is
  // deleted, L holds after every chunk, and the drained table is exact.
  for (const [name, order] of Object.entries(ORDERS)) {
    test(`remove a link mid-walk, ${name}`, async () => {
      const t = zbarEngineTest();
      const z = engine(t, graphConfig([MANAGE], { writeBudget: 2 }));
      const p12 = await z.add("group:g1", "parent", "group:g2");
      await z.add("group:g2", "parent", "group:g3");
      await z.add("group:g3", "parent", "group:g4");
      await z.add("user:a", "manage", "group:g1");
      await drain(t);
      await z.add("user:u", "manage", "group:g1"); // derives u→g2, parks the rest
      expect((await parked(t)).length).toBeGreaterThan(0);
      await z.remove("group:g1", "parent", "group:g2");
      const atDeletion = await pathsNaming(t, p12);
      for (
        let tasks = await parked(t);
        tasks.length > 0;
        tasks = await parked(t)
      ) {
        await runTask(t, tasks[order(tasks)]);
        for (const p of await pathsNaming(t, p12))
          expect(atDeletion.has(p), p).toBe(true);
        await expectLineage(t);
      }
      await expectRemoved(t, p12);
      await expectExact(t, [MANAGE], 16);
    });
  }

  test("an add cursor whose source path names a deleted fact writes nothing from that path", async () => {
    const t = zbarEngineTest();
    const z = engine(t, graphConfig([MANAGE], { writeBudget: 2 }));
    const p12 = await z.add("group:g1", "parent", "group:g2");
    await z.add("group:g2", "parent", "group:g3");
    await z.add("user:a", "manage", "group:g1");
    await drain(t);
    await z.add("user:u", "manage", "group:g1");
    await z.remove("group:g1", "parent", "group:g2");
    // Every add cursor first: under the old Lemma R design these wrote u→g3
    // with g1→g2 in its lineage and relied on the retraction to clean it.
    for (
      let task = (await parked(t)).find((x) => x.args.items[0].kind === "add");
      task;
    ) {
      await runTask(t, task);
      task = (await parked(t)).find((x) => x.args.items[0].kind === "add");
    }
    const rows = (await snapshot(t)).rows;
    expect(
      rows.find(
        (r: any) => r.subjectKey === "user:u" && r.objectKey === "group:g3",
      ),
    ).toBeUndefined();
    await drain(t);
    await expectRemoved(t, p12);
    await expectExact(t, [MANAGE], 16);
  });
});

describe("Invariant L: removal finds every path naming the fact, whatever config wrote it", () => {
  test("removing a fact under config A retracts rows that only config B derives", async () => {
    const t = zbarEngineTest();
    const b = engine(t, graphConfig([TEAM, ORG]), "B");
    const a = engine(t, graphConfig([TEAM]), "A");
    const us = await b.add("user:u", "member", "squad:s");
    await b.add("squad:s", "member", "team:t");
    await b.add("team:t", "viewer", "org:o");
    await drain(t);
    const viewer = (rows: any[]) =>
      rows.find((r) => r.subjectKey === "user:u" && r.relation === "viewer");
    expect(viewer((await snapshot(t)).rows).paths[0].rule).toBe(ORG.key);

    // Config A has no ORG rule, so no rule of A locates (u, viewer, o). Its
    // registration parks a rebuild under A, which would retire ORG paths
    // for another reason; drop it so only the removal runs.
    await a.remove("user:u", "member", "squad:s");
    await discardRebuilds(t);
    await drain(t);
    await expectRemoved(t, us);
    expect(viewer((await snapshot(t)).rows)).toBeUndefined();
    await expectExact(t, [TEAM, ORG], 16);
  });

  for (const [name, order] of Object.entries(ORDERS)) {
    test(`two retractions that share a path, ${name}`, async () => {
      const t = zbarEngineTest();
      const z = engine(t, graphConfig(ALL_RULES, { writeBudget: 2 }));
      const a = await z.add("user:u", "member", "squad:s");
      const b = await z.add("squad:s", "member", "team:t");
      await z.add("team:t", "viewer", "org:o");
      await z.add("user:v", "member", "squad:s");
      await drain(t);
      await z.remove("user:u", "member", "squad:s");
      await z.remove("squad:s", "member", "team:t");
      await drain(t, order);
      await expectRemoved(t, a);
      await expectRemoved(t, b);
      await expectExact(t, ALL_RULES, 16);
    });
  }
});
