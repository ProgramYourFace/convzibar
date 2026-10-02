/**
 * Shared harness for the write-time BFS proofs (convex/components/convzibar/
 * EXPANSION.md §6): hand-written configs, a driver for parked cursors, and an
 * INDEPENDENT reference evaluator of the derivation relation (EXPANSION.md
 * §1.2) that the drained table is compared against. Nothing here imports the
 * engine's own derivation code (`pathId` is the lineage table's encoding, a
 * definition, not logic under test).
 */
import { expect } from "vitest";
import { api, internal } from "../../component/_generated/api";
import { pathId } from "../../component/paths";
import type { GraphConfig, TraversalRule } from "../../component/types";

// ---------------------------------------------------------------------------
// Configs.
// ---------------------------------------------------------------------------

/** A rule in the compiler's shape. The key is any unique string to the engine; this one is readable. */
export function rule(r: {
  objectType: string;
  derived: string;
  firstHop: string;
  intermediateType: string;
  relations?: string[];
  inverses?: { subjectType: string; relation: string }[];
  target?: string;
}): TraversalRule {
  return {
    key: `${r.objectType}.${r.derived}<=${r.firstHop}:${r.intermediateType}#${r.target ?? "x"}`,
    objectType: r.objectType,
    derived: r.derived,
    firstHop: { relation: r.firstHop, intermediateType: r.intermediateType },
    secondHop: { relations: r.relations ?? [], inverses: r.inverses ?? [] },
  };
}

export function graphConfig(
  rules: TraversalRule[],
  o: { writeBudget?: number; maxDepth?: number; mock?: boolean } = {},
): GraphConfig {
  return {
    version: 2,
    sets: {},
    inherits: {},
    factRelations: {},
    rules,
    maxDepth: o.maxDepth ?? 16,
    writeBudget: o.writeBudget ?? 1000,
    mockWorkpool: o.mock ?? true,
  };
}

// The schema the race and removal proofs run on. It has every shape a rule
// can take: a chained expands (team.member feeds org.viewer), a recursive
// walk (group.manage through group.parent, cycles allowed), and a rule whose
// second hop is both a materialized relation and an inverse arm (two parts).
export const TEAM = rule({
  objectType: "team",
  derived: "member",
  firstHop: "member",
  intermediateType: "squad",
  relations: ["member"],
  target: "member",
});
export const ORG = rule({
  objectType: "org",
  derived: "viewer",
  firstHop: "viewer",
  intermediateType: "team",
  relations: ["member"],
  target: "member",
});
export const MANAGE = rule({
  objectType: "group",
  derived: "manage",
  firstHop: "parent",
  intermediateType: "group",
  relations: ["manage"],
  target: "manage",
});
export const SOURCE = rule({
  objectType: "nrule",
  derived: "source",
  firstHop: "source",
  intermediateType: "group",
  relations: ["manage"],
  inverses: [{ subjectType: "device", relation: "holds" }],
  target: "devices",
});
export const ALL_RULES = [TEAM, ORG, MANAGE, SOURCE];

// ---------------------------------------------------------------------------
// Driving the engine.
// ---------------------------------------------------------------------------

const node = (k: string) => {
  const i = k.indexOf(":");
  return { type: k.slice(0, i), id: k.slice(i + 1) };
};

/** The public writes, bound to one config and hash. Nodes are written `type:id`. */
export function engine(
  t: any,
  config: GraphConfig,
  configHash = "expansion-test",
) {
  const c = { configHash, graphConfig: config };
  return {
    config,
    configHash,
    add: (s: string, r: string, o: string) =>
      t.mutation(api.mutations.addRelation, {
        subject: node(s),
        relation: r,
        object: node(o),
        ...c,
      }),
    remove: (s: string, r: string, o: string) =>
      t.mutation(api.mutations.removeRelation, {
        subject: node(s),
        relation: r,
        object: node(o),
        ...c,
      }),
    set: (s: string, r: string, o: string, objectRelations: string[]) =>
      t.mutation(api.mutations.setRelation, {
        subject: node(s),
        relation: r,
        object: node(o),
        objectRelations,
        ...c,
      }),
    deleteEntity: (n: string) =>
      t.mutation(api.mutations.deleteEntity, { entity: node(n), ...c }),
    rebuild: () => t.mutation(api.mutations.rebuild, c),
  };
}

export type Task = { _id: string; args: any };

export const parked = (t: any): Promise<Task[]> =>
  t.query(internal.mutations.getMockWorkpool, {});

/** Run one parked cursor (removing it from the park first, as the pool would). */
export async function runTask(t: any, task: Task) {
  await t.mutation(internal.mutations.deleteMockWorkpoolTask, { id: task._id });
  await t.mutation(internal.mutations.continueExpansion, task.args);
}

/** Run parked cursors until none is left; `pick` chooses which runs next. */
export async function drain(t: any, pick: (tasks: Task[]) => number = () => 0) {
  for (let i = 0; i < 50_000; i++) {
    const tasks = await parked(t);
    if (tasks.length === 0) return i;
    await runTask(t, tasks[pick(tasks)]);
  }
  throw new Error("drain did not terminate");
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The reference: EXPANSION.md §1.2 evaluated naively.
// ---------------------------------------------------------------------------

export interface RefFact {
  id: string;
  s: string;
  r: string;
  o: string;
}

const typeOf = (k: string) => k.slice(0, k.indexOf(":"));
const rowKey = (s: string, r: string, o: string) => `${s} ${r} ${o}`;
const lineage = (ids: string[]) => [...new Set(ids)].sort();

/**
 * `Min Λ_F(k)` for every key, by fixed-point iteration over (M), (R), (V).
 * The map's value is the set of minimal lineages (each a sorted id list).
 */
export function reference(
  facts: RefFact[],
  rules: TraversalRule[],
  maxDepth: number,
) {
  const table = new Map<
    string,
    { s: string; r: string; o: string; paths: string[][] }
  >();
  const merge = (s: string, r: string, o: string, cand: string[]) => {
    const key = rowKey(s, r, o);
    let row = table.get(key);
    if (!row) table.set(key, (row = { s, r, o, paths: [] }));
    const c = new Set(cand);
    if (row.paths.some((p) => p.every((id) => c.has(id)))) return false;
    row.paths = row.paths.filter((p) => !cand.every((id) => p.includes(id)));
    row.paths.push(cand);
    return true;
  };
  for (const f of facts) merge(f.s, f.r, f.o, [f.id]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const rho of rules) {
      for (const f of facts) {
        if (f.r !== rho.firstHop.relation) continue;
        if (
          typeOf(f.o) !== rho.objectType ||
          typeOf(f.s) !== rho.firstHop.intermediateType
        )
          continue;
        for (const e of [...table.values()]) {
          if (e.o !== f.s || !rho.secondHop.relations.includes(e.r)) continue;
          for (const p of e.paths) {
            const cand = lineage([f.id, ...p]);
            if (cand.length <= maxDepth && merge(e.s, rho.derived, f.o, cand))
              changed = true;
          }
        }
        for (const g of facts) {
          if (g.s !== f.s) continue;
          if (
            !rho.secondHop.inverses.some(
              (i) => i.relation === g.r && i.subjectType === typeOf(g.o),
            )
          )
            continue;
          const cand = lineage([f.id, g.id]);
          if (cand.length <= maxDepth && merge(g.o, rho.derived, f.o, cand))
            changed = true;
        }
      }
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// Reading and checking the drained state.
// ---------------------------------------------------------------------------

export async function snapshot(t: any) {
  return await t.run(async (ctx: any) => ({
    facts: (await ctx.db.query("relationships").collect()).map(
      (f: any): RefFact => ({
        id: f._id,
        s: `${f.subjectType}:${f.subjectId}`,
        r: f.relation,
        o: `${f.objectType}:${f.objectId}`,
      }),
    ),
    rows: await ctx.db.query("effectiveRelationships").collect(),
    failures: await ctx.db.query("expansionFailures").collect(),
    lineage: await ctx.db.query("lineage").collect(),
  }));
}

/**
 * Discard the `rebuild` items of the parked cursors (registering a config owes
 * one; a test that isolates another mechanism drops it). A cursor left with
 * no item goes; one with other items is parked again without them.
 */
export async function discardRebuilds(t: any) {
  for (const task of await parked(t)) {
    const items = task.args.items.filter((i: any) => i.kind !== "rebuild");
    if (items.length === task.args.items.length) continue;
    await t.mutation(internal.mutations.deleteMockWorkpoolTask, {
      id: task._id,
    });
    if (items.length > 0) {
      await t.run((ctx: any) =>
        ctx.db.insert("mockWorkpool", {
          mutationName: "continueExpansion",
          args: { ...task.args, items },
        }),
      );
    }
  }
}

/**
 * Invariant L (EXPANSION.md §1.4), which every committed state keeps, drained
 * or not: the lineage table is exactly one row per (fact, row, stored path)
 * with the fact in the path.
 */
export async function expectLineage(t: any) {
  const { rows, lineage } = await snapshot(t);
  const expected = rows
    .flatMap((r: any) =>
      r.paths
        .filter((p: any) => p.rule !== undefined)
        .flatMap((p: any) =>
          p.baseIds.map((f: string) => `${f} ${r._id} ${pathId(p)}`),
        ),
    )
    .sort();
  const actual = lineage
    .map((l: any) => `${l.factId} ${l.rowId} ${l.path}`)
    .sort();
  expect(actual).toEqual(expected);
}

const canon = (paths: string[][]) => paths.map((p) => p.join(",")).sort();

/**
 * Assert the table is exact for the facts present (EXPANSION.md §1.3 via
 * Lemma 1): the row keys are E*, every row's paths are exactly Min Λ (rows
 * store an antichain), every path has at most `maxDepth` live facts, every
 * path justifies its row, and the lineage table is exactly L.
 */
export async function expectExact(
  t: any,
  rules: TraversalRule[],
  maxDepth: number,
) {
  await expectLineage(t);
  const { facts, rows } = await snapshot(t);
  const ref = reference(facts, rules, maxDepth);
  const live = new Set(facts.map((f: RefFact) => f.id));

  const actual = Object.fromEntries(
    rows.map((r: any) => [
      rowKey(r.subjectKey, r.relation, r.objectKey),
      canon(r.paths.map((p: any) => [...p.baseIds].sort())),
    ]),
  );
  const expected = Object.fromEntries(
    [...ref].map(([k, row]) => [k, canon(row.paths)]),
  );
  expect(actual).toEqual(expected);

  const factById = new Map(facts.map((f: RefFact) => [f.id, f]));
  for (const row of rows) {
    expect(row.paths.length).toBeGreaterThan(0);
    for (const p of row.paths) {
      expect(p.baseIds.length).toBeLessThanOrEqual(maxDepth);
      for (const id of p.baseIds) expect(live.has(id)).toBe(true);
      // Sound: the path's own facts derive the row.
      const own = reference(
        p.baseIds.map((id: string) => factById.get(id)!),
        rules,
        maxDepth,
      );
      expect(own.has(rowKey(row.subjectKey, row.relation, row.objectKey))).toBe(
        true,
      );
    }
  }
  return { facts, rows };
}

/** The table in a form that does not depend on document ids: lineages as fact triples. */
export async function portable(
  t: any,
): Promise<{ rows: string[]; failures: any[] }> {
  const { facts, rows, failures } = await snapshot(t);
  const name = new Map(
    facts.map((f: RefFact) => [f.id, `${f.s}/${f.r}/${f.o}`]),
  );
  return {
    rows: rows
      .map((r: any) =>
        [
          rowKey(r.subjectKey, r.relation, r.objectKey),
          ...canon(
            r.paths.map((p: any) =>
              p.baseIds.map((id: string) => name.get(id) ?? id).sort(),
            ),
          ),
        ].join(" | "),
      )
      .sort(),
    failures,
  };
}
