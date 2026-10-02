/**
 * The parity test: the executable form of CONTRACT.md §4,
 *
 *     "Materialization never changes an answer."
 *
 * Every fixture (`./fixtures/*.ts`) is ONE description of a schema plus a
 * sequence of writes. `deriveSchemas` builds two schemas from it: `computed`
 * (every walks/expands arm computed at read time) and `materialized` (every
 * walks/expands arm that may legally be materialized wrapped in
 * `materialize()`; see `fixtures/derive.ts`). Each runs on its own convex-test
 * instance of the engine with `writeBudget: 2`, so expansion continues in the
 * workpool from a cursor (§5.3); the workpool is drained after every write.
 * After every step the test compares, for the whole universe of the fixture:
 *
 *   can · hasRelationship · getPermissions · list (forward) · list (reverse)
 *   · list().via(x) both ways · listDirect
 *
 * and reports the first mismatches with the step, the read and both answers.
 * For the pure-relational fixtures (D1, D2, D7, S6) both engines are also
 * checked against `fixtures/oracle.ts`, an evaluator of §2 written from the
 * contract text, so the two engines cannot agree on a wrong answer.
 */
import { zbarEngineTest } from "../../test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Zbar } from "../index";
import { api, components } from "../../component/_generated/api";
import { appSchema } from "./fixtures/appSchema";
import { d1TypedIntermediate } from "./fixtures/d1TypedIntermediate";
import { d2FirstHopFacts } from "./fixtures/d2FirstHopFacts";
import { d3MixedArms } from "./fixtures/d3MixedArms";
import {
  acyclicChain,
  recursiveChain,
  recursiveFolders,
  recursiveSeat,
} from "./fixtures/d5Depth";
import { d6Inherits } from "./fixtures/d6Inherits";
import { d7Via } from "./fixtures/d7Via";
import { deriveSchemas, SchemaIndex } from "./fixtures/derive";
import { folderTree } from "./fixtures/folderTree";
import { FactLog, Oracle } from "./fixtures/oracle";
import { randomFixture } from "./fixtures/random";
import { s6Ladder } from "./fixtures/s6Ladder";
import {
  add,
  describeOp,
  entity,
  node,
  nodeKey,
  perm,
  rel,
  type Fixture,
  type Node,
  type Op,
} from "./fixtures/types";

// The workpool's timers are faked so the test can pump them; only setTimeout,
// as in the other workpool-backed suites.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Generous: the full cross-product of reads runs after every step, on two engines. */
const TIMEOUT = 600_000;

// ---------------------------------------------------------------------------
// One engine instance ("side")
// ---------------------------------------------------------------------------

interface Side {
  name: "computed" | "materialized";
  t: ReturnType<typeof zbarEngineTest>;
  ctx: any;
  zbar: any;
}

function makeSide(name: Side["name"], schema: any, fixture: Fixture): Side {
  const t = zbarEngineTest();
  const ctx = {
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  } as any;
  const zbar = new Zbar(api, {
    schema,
    writeBudget: 2,
    maxDepth: fixture.maxDepth ?? 16,
  });
  return { name, t, ctx, zbar };
}

async function applyOp(side: Side, op: Op) {
  const { zbar, ctx } = side;
  try {
    switch (op.op) {
      case "add":
        await zbar.addRelation(
          ctx,
          op.subject,
          op.relation,
          op.object,
          op.properties ? { properties: op.properties } : undefined,
        );
        return;
      case "remove":
        await zbar.removeRelation(ctx, op.subject, op.relation, op.object);
        return;
      case "set":
        await zbar.setRelation(ctx, op.subject, op.relation, op.object);
        return;
      case "deleteEntity":
        await zbar.deleteEntity(ctx, op.entity);
        return;
    }
  } catch (e) {
    throw new Error(
      `[${side.name}] write "${describeOp(op)}" threw: ${(e as Error).message}`,
    );
  }
}

/**
 * Run the workpool until it is idle: nothing waiting, running, completing or
 * canceling for two consecutive rounds. (`finishAllScheduledFunctions` never
 * returns here: the workpool's monitor reschedules itself forever.)
 */
async function drain(side: Side, maxRounds = 500) {
  const diagnostics = (components as any).workpool.stats.diagnostics;
  let idle = 0;
  for (let round = 0; round < maxRounds; round++) {
    vi.advanceTimersByTime(1000);
    await side.t.finishInProgressScheduledFunctions();
    const d = await side.t.query(diagnostics, {});
    idle =
      d.waiting + d.running + d.completing + d.canceling === 0 ? idle + 1 : 0;
    if (idle >= 2) return;
  }
  throw new Error(
    `[${side.name}] the workpool did not drain within ${maxRounds} rounds`,
  );
}

/** The recorded expansion failures (§5.7), through the client's query; the table directly if that is not there yet. */
async function expansionFailures(side: Side): Promise<any[]> {
  try {
    return await side.zbar.listExpansionFailures(side.ctx);
  } catch {
    return side.t.run((c: any) => c.db.query("expansionFailures").collect());
  }
}

// ---------------------------------------------------------------------------
// The reads: one plan per fixture, run on both engines and on the oracle
// ---------------------------------------------------------------------------

interface Read {
  op: string;
  args: string;
  run: (zbar: any, ctx: any) => Promise<unknown>;
  /** The oracle's answer, for the reads it can state (not `.via()` or `listDirect`). */
  expected?: (o: Oracle) => unknown;
  /**
   * Depth reads: the read's subject and the objects of the rows its
   * derivation passes through (its own row first), as scope keys. Ties a
   * refused read to the depth failure that explains it.
   */
  about?: { subjectKey: string; objectKeys: string[] };
}

const k = nodeKey;
const sortedIds = (rows: any[], field: "objectId" | "subjectId") =>
  [...new Set(rows.map((r) => r[field] as string))].sort();
const directRow = (r: any) =>
  `(${k(r.subject)}, ${r.relation}, ${k(r.object)})` +
  (r.properties && Object.keys(r.properties).length
    ? " " +
      JSON.stringify(Object.fromEntries(Object.entries(r.properties).sort()))
    : "");

function readPlan(f: Pick<Fixture, "schema" | "nodes" | "via">): Read[] {
  const ix = new SchemaIndex(f.schema);
  const types = f.schema.map((e) => e.name);
  const vias: (Node | null)[] = [null, ...(f.via ?? [])];
  const viaArg = (v: Node | null) => (v ? ` via ${k(v)}` : "");
  const withVia = (q: any, v: Node | null) => (v ? q.via(v) : q);
  const reads: Read[] = [];

  // can / hasRelationship / getPermissions for every (subject, object) pair.
  for (const object of f.nodes)
    for (const subject of f.nodes) {
      for (const s of ix.sets(object.type)) {
        const args = `(${k(subject)}, ${s.name}, ${k(object)})`;
        reads.push(
          s.kind === "permission"
            ? {
                op: "can",
                args,
                run: (z, ctx) => z.can(ctx, subject, s.name, object),
                expected: (o) => o.check(subject, s.name, object),
              }
            : {
                op: "hasRelationship",
                args,
                run: (z, ctx) =>
                  z.hasRelationship(ctx, subject, s.name, object),
                expected: (o) => o.check(subject, s.name, object),
              },
        );
      }
      if (ix.permissions(object.type).length > 0)
        reads.push({
          op: "getPermissions",
          args: `(${k(subject)}, ${k(object)})`,
          run: async (z, ctx) =>
            [...(await z.getPermissions(ctx, subject, object))].sort(),
          expected: (o) => o.permissions(subject, object),
        });
    }

  // list forward: every subject × object type × set (× via).
  for (const subject of f.nodes)
    for (const type of types)
      for (const s of ix.sets(type))
        for (const v of vias)
          reads.push({
            op: v ? "list.via" : "list",
            args: `object(${type}).${s.kind}(${s.name}).subject(${k(subject)})${viaArg(v)}`,
            run: async (z, ctx) =>
              sortedIds(
                await withVia(
                  z.list().object(type)[s.kind](s.name).subject(subject),
                  v,
                ).collect(ctx),
                "objectId",
              ),
            expected: v
              ? undefined
              : (o) => o.listObjects(type, s.name, subject),
          });

  // list reverse: every object × subject type × set (× via).
  for (const object of f.nodes)
    for (const s of ix.sets(object.type))
      for (const type of types)
        for (const v of vias)
          reads.push({
            op: v ? "list.via" : "list",
            args: `object(${k(object)}).${s.kind}(${s.name}).subject(${type})${viaArg(v)}`,
            run: async (z, ctx) =>
              sortedIds(
                await withVia(
                  z.list().object(object)[s.kind](s.name).subject(type),
                  v,
                ).collect(ctx),
                "subjectId",
              ),
            expected: v
              ? undefined
              : (o) => o.listSubjects(object, s.name, type),
          });

  // listDirect: every object × relation (facts only, with properties).
  for (const object of f.nodes)
    for (const r of ix.relations(object.type))
      reads.push({
        op: "listDirect",
        args: `object(${k(object)}).relation(${r.name})`,
        run: async (z, ctx) =>
          (await z.listDirect().object(object).relation(r.name).collect(ctx))
            .map(directRow)
            .sort(),
      });

  return reads;
}

interface Entry {
  read: Read;
  /** JSON of the answer, or `<threw>` (the message is kept for the report only). */
  value: string;
  error?: string;
}

async function snapshot(side: Side, plan: Read[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const read of plan) {
    try {
      out.push({
        read,
        value: JSON.stringify(await read.run(side.zbar, side.ctx)),
      });
    } catch (e) {
      out.push({ read, value: "<threw>", error: (e as Error).message });
    }
  }
  return out;
}

const show = (e: { value: string; error?: string }) =>
  e.error ? `threw: ${e.error}` : e.value;

function reportMismatches(
  title: string,
  labels: [string, string],
  mismatches: {
    read: Read;
    a: { value: string; error?: string };
    b: { value: string; error?: string };
  }[],
  total: number,
): never {
  const shown = mismatches
    .slice(0, 8)
    .map(
      ({ read, a, b }) =>
        `  ${read.op}${read.op.startsWith("list") ? " " : ""}${read.args}\n` +
        `    ${labels[0].padEnd(13)} ${show(a)}\n` +
        `    ${labels[1].padEnd(13)} ${show(b)}`,
    );
  throw new Error(
    `${title}: ${mismatches.length} of ${total} reads differ` +
      `${mismatches.length > shown.length ? ` (first ${shown.length} shown)` : ""}\n${shown.join("\n")}`,
  );
}

function compareSnapshots(
  title: string,
  labels: [string, string],
  a: Entry[],
  b: Entry[],
) {
  const mismatches = a
    .map((ea, i) => ({ read: ea.read, a: ea, b: b[i] }))
    .filter(({ a: ea, b: eb }) => ea.value !== eb.value);
  if (mismatches.length > 0)
    reportMismatches(title, labels, mismatches, a.length);
}

/**
 * Every read on the computed engine equals the same read on the materialized
 * engine. Returns both snapshots for further checks.
 */
async function assertParity(
  stepName: string,
  computed: Side,
  materialized: Side,
  universe: Pick<Fixture, "schema" | "nodes" | "via"> | Read[],
) {
  const plan = Array.isArray(universe) ? universe : readPlan(universe);
  const c = await snapshot(computed, plan);
  const m = await snapshot(materialized, plan);
  compareSnapshots(
    `parity after step "${stepName}"`,
    ["computed", "materialized"],
    c,
    m,
  );
  return { computed: c, materialized: m };
}

/** Every read the oracle can state agrees with the contract's own evaluation. */
function assertOracle(
  stepName: string,
  side: Side["name"],
  entries: Entry[],
  oracle: Oracle,
) {
  const mismatches = entries
    .filter((e) => e.read.expected)
    .map((e) => ({
      read: e.read,
      a: { value: JSON.stringify(e.read.expected!(oracle)) },
      b: e,
    }))
    .filter(({ a, b }) => a.value !== b.value);
  if (mismatches.length > 0)
    reportMismatches(
      `${side} engine vs the CONTRACT §2 oracle after step "${stepName}"`,
      ["contract", side],
      mismatches,
      entries.length,
    );
}

// ---------------------------------------------------------------------------
// Fixture runner
// ---------------------------------------------------------------------------

async function sides(f: Fixture) {
  const schemas = deriveSchemas(f.schema);
  // The comparison is meaningless if the "materialized" variant materialized nothing.
  expect(
    schemas.materializedArms.length,
    `${f.name}: no arm was materializable`,
  ).toBeGreaterThan(0);
  return {
    computed: makeSide("computed", schemas.computed, f),
    materialized: makeSide("materialized", schemas.materialized, f),
    schemas,
  };
}

async function applyStepOps(
  computed: Side,
  materialized: Side,
  ops: Op[],
  log: FactLog,
) {
  for (const op of ops) {
    await applyOp(computed, op);
    await drain(computed);
    await applyOp(materialized, op);
    await drain(materialized);
    log.apply(op);
  }
}

async function runFixture(f: Fixture, opts: { oracle?: boolean } = {}) {
  const { computed, materialized } = await sides(f);
  const log = new FactLog();
  const plan = readPlan(f);
  let last: { computed: Entry[]; materialized: Entry[] } | undefined;
  for (const step of f.steps) {
    await applyStepOps(computed, materialized, step.ops, log);
    // §4.10: the invariant holds once expansion drained and NO chunk failed.
    expect(
      await expansionFailures(materialized),
      `${f.name} / ${step.name}: expansion recorded failures`,
    ).toEqual([]);
    last = await assertParity(
      `${f.name} / ${step.name}`,
      computed,
      materialized,
      plan,
    );
    if (opts.oracle) {
      const oracle = new Oracle(f.schema, log.all(), f.nodes);
      assertOracle(
        `${f.name} / ${step.name}`,
        "computed",
        last.computed,
        oracle,
      );
      assertOracle(
        `${f.name} / ${step.name}`,
        "materialized",
        last.materialized,
        oracle,
      );
    }
  }
  return { computed, materialized, last: last! };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe("parity: appSchema (proposal §2)", () => {
  test(
    "every read agrees after each step",
    () => runFixture(appSchema),
    TIMEOUT,
  );
});

describe("parity: folderTree (recursive walks, a permission walking a permission)", () => {
  test(
    "every read agrees after each step, including a cut in the middle",
    () => runFixture(folderTree),
    TIMEOUT,
  );
});

describe("parity: D1 typed intermediate", () => {
  test(
    "a seat at operator never expands through its own viewer set; both engines match the contract",
    () => runFixture(d1TypedIntermediate, { oracle: true }),
    TIMEOUT,
  );
});

describe("parity: D2 first hop reads facts", () => {
  test(
    "a member two levels down does not read; both engines match the contract",
    () => runFixture(d2FirstHopFacts, { oracle: true }),
    TIMEOUT,
  );
});

describe("parity: D3 materialized expands over an inverse arm", () => {
  test(
    "devices joining and leaving the group after the rule exists",
    () => runFixture(d3MixedArms),
    TIMEOUT,
  );
});

describe("parity: D5 depth", () => {
  test(
    "a 6-long acyclic walks chain: equal under both write orders",
    async () => {
      const td = await runFixture(acyclicChain("top-down"));
      const bu = await runFixture(acyclicChain("bottom-up"));
      // Same final facts, different write order → identical answers (§4.7).
      compareSnapshots(
        "materialized: top-down vs bottom-up",
        ["top-down", "bottom-up"],
        td.last.materialized,
        bu.last.materialized,
      );
      compareSnapshots(
        "computed: top-down vs bottom-up",
        ["top-down", "bottom-up"],
        td.last.computed,
        bu.last.computed,
      );
    },
    TIMEOUT,
  );

  test(
    "a recursive chain past maxDepth: a hit found too long is refused on both sides, a deeper miss is no on both",
    async () => {
      const { computed, materialized } = await sides(recursiveChain);
      const log = new FactLog();
      for (const step of recursiveChain.steps)
        await applyStepOps(computed, materialized, step.ops, log);

      // f_k is k-1 walks from f1, where the grant is: its derivation uses k facts; maxDepth 4.
      const [f1, f2, f3, f4, f5, f6, f7] = recursiveFolders;
      const view = (f: Node): Read => ({
        op: "hasRelationship",
        args: `(${k(recursiveSeat)}, viewer, ${k(f)})`,
        run: (z, ctx) => z.hasRelationship(ctx, recursiveSeat, "viewer", f),
      });
      // Within the bound both engines agree, and so do the misses past it.
      await assertParity(
        "recursive chain",
        computed,
        materialized,
        [f1, f2, f3, f4, f6, f7].map(view),
      );
      expect(
        await computed.zbar.hasRelationship(
          computed.ctx,
          recursiveSeat,
          "viewer",
          f4,
        ),
      ).toBe(true);
      expect(
        await computed.zbar.hasRelationship(
          computed.ctx,
          recursiveSeat,
          "viewer",
          f6,
        ),
      ).toBe(false);

      // f5's derivation (5 facts) is found within 4 walks: the computed read
      // refuses it, the materialized write recorded a depth failure.
      await expect(
        computed.zbar.hasRelationship(
          computed.ctx,
          recursiveSeat,
          "viewer",
          f5,
        ),
      ).rejects.toThrow(/maxDepth/);
      expect(
        await materialized.zbar.hasRelationship(
          materialized.ctx,
          recursiveSeat,
          "viewer",
          f5,
        ),
      ).toBe(false);
      expect(
        (await expansionFailures(materialized)).map((f) => f.reason),
      ).toContain("depth");
    },
    TIMEOUT,
  );
});

/**
 * CONTRACT §4.7 on both sides: for every read, the two engines answer the
 * same, or the computed side refused (threw) and the materialized side has a
 * depth failure on record for THAT derivation: on the read's own row, or on a
 * row its derivation passes through (the write side refused that prefix, so
 * it never attempted the longer derivation). Conversely, every depth failure
 * is on the own row of a read the computed side refused. Nothing else may
 * differ.
 */
async function assertDepthParity(
  computed: Side,
  materialized: Side,
  reads: Read[],
) {
  const c = await snapshot(computed, reads);
  const m = await snapshot(materialized, reads);
  const failures = (await expansionFailures(materialized)).filter(
    (f) => f.reason === "depth",
  );
  const on = (f: any, subjectKey: string, objectKeys: string[]) =>
    f.cursor.row.subjectKey === subjectKey &&
    objectKeys.includes(f.cursor.row.objectKey);
  const explained = (read: Read) =>
    read.about !== undefined &&
    failures.some((f) => on(f, read.about!.subjectKey, read.about!.objectKeys));
  const unexplained = c
    .map((ec, i) => ({ read: ec.read, a: ec, b: m[i] }))
    .filter(
      ({ read, a, b }) =>
        a.value !== b.value && !(a.value === "<threw>" && explained(read)),
    );
  for (const f of failures) {
    const refused = c.some(
      (e) =>
        e.value === "<threw>" &&
        e.read.about !== undefined &&
        on(f, e.read.about.subjectKey, e.read.about.objectKeys.slice(0, 1)),
    );
    expect(
      refused,
      `depth failure on (${f.cursor.row.subjectKey}, ${f.cursor.row.objectKey}) with no refused read`,
    ).toBe(true);
  }
  if (unexplained.length > 0)
    reportMismatches(
      "depth parity",
      ["computed", "materialized"],
      unexplained,
      c.length,
    );
  return { computed: c, materialized: m };
}

describe("parity: the depth rule is one rule (CONTRACT §4.7)", () => {
  const u = node("user", "u");
  const sys = node("system", "s");
  const folders = Array.from({ length: 10 }, (_, i) =>
    node("folder", `f${i + 1}`),
  );
  // folder.viewer ⊇ parent.viewer: through the system (1 + system.viewer's 1
  // fact = a Compose base of 2 facts) and recursively through a folder.
  const schema = [
    entity("user"),
    entity("system", [rel("admin", "user"), rel("viewer", "admin")]),
    entity("folder", [
      rel("parent", "system", "folder"),
      rel("viewer", "parent.viewer"),
      perm("view", "viewer"),
    ]),
  ];
  const chain = (n: number): Op[] => [
    add(sys, "parent", folders[0]),
    ...folders.slice(1, n).map((f, i) => add(folders[i], "parent", f)),
  ];
  const reads = (n: number): Read[] =>
    folders.slice(0, n).flatMap((f, i): Read[] => {
      // f's derivation passes through (u, viewer, f_j) for every j ≤ i.
      const about = {
        subjectKey: k(u),
        objectKeys: folders
          .slice(0, i + 1)
          .reverse()
          .map(k),
      };
      return [
        {
          op: "hasRelationship",
          args: `(u, viewer, ${k(f)})`,
          run: (z, ctx) => z.hasRelationship(ctx, u, "viewer", f),
          about,
        },
        {
          op: "can",
          args: `(u, view, ${k(f)})`,
          run: (z, ctx) => z.can(ctx, u, "view", f),
          about,
        },
      ];
    });

  test("an acyclic chain longer than maxDepth is a load-time error, not a runtime one", () => {
    const { computed, materialized } = deriveSchemas(
      acyclicChain("top-down").schema,
    );
    // root.viewer is 1 fact, l6.viewer 7.
    for (const schema of [computed, materialized]) {
      expect(() => new Zbar(api, { schema, maxDepth: 6 })).toThrow(
        /longest derivation of 'l6\.view\w*' uses 7 facts, more than maxDepth \(6\)/,
      );
      expect(() => new Zbar(api, { schema, maxDepth: 7 })).not.toThrow();
    }
  });

  test(
    "a closure whose base is a walk counts the walk`s facts: refused on one side exactly where the other recorded a failure",
    async () => {
      const f: Fixture = {
        name: "depth: closure with a compose base",
        schema,
        nodes: [u, sys, ...folders.slice(0, 6)],
        maxDepth: 4,
        steps: [
          { name: "chain + grant", ops: [...chain(6), add(u, "admin", sys)] },
        ],
      };
      const { computed, materialized } = await sides(f);
      await applyStepOps(computed, materialized, f.steps[0].ops, new FactLog());
      // f_k: k-1 walks + (s parent f1) + (u admin s) = k+1 facts.
      const { computed: c } = await assertDepthParity(
        computed,
        materialized,
        reads(6),
      );
      const answers = c
        .filter((e) => e.read.op === "hasRelationship")
        .map((e) => e.value);
      expect(answers).toEqual([
        "true",
        "true",
        "true",
        "<threw>",
        "<threw>",
        "false",
      ]);
    },
    TIMEOUT,
  );

  test(
    "a chain deeper than maxDepth with no grant anywhere answers no on both sides, and nothing throws",
    async () => {
      const f: Fixture = {
        name: "depth: deep chain, no grants",
        schema,
        nodes: [u, sys, ...folders],
        maxDepth: 4,
        steps: [{ name: "chain", ops: chain(10) }],
      };
      const { computed, materialized } = await sides(f);
      await applyStepOps(computed, materialized, f.steps[0].ops, new FactLog());
      const listReads: Read[] = [
        {
          op: "list",
          args: "object(folder).relation(viewer).subject(u)",
          run: async (z, ctx) =>
            sortedIds(
              await z
                .list()
                .object("folder")
                .relation("viewer")
                .subject(u)
                .collect(ctx),
              "objectId",
            ),
        },
        {
          op: "list",
          args: `object(${k(folders[9])}).relation(viewer).subject(user)`,
          run: async (z, ctx) =>
            sortedIds(
              await z
                .list()
                .object(folders[9])
                .relation("viewer")
                .subject("user")
                .collect(ctx),
              "subjectId",
            ),
        },
      ];
      const { computed: c } = await assertParity(
        "deep chain, no grants",
        computed,
        materialized,
        [...reads(10), ...listReads],
      );
      expect(c.every((e) => e.value === "false" || e.value === "[]")).toBe(
        true,
      );
      expect(await expansionFailures(materialized)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("parity: D6 inherits (the prune counter-example)", () => {
  test(
    "a team written only at editor has readers; walks into an expanding set",
    () => runFixture(d6Inherits),
    TIMEOUT,
  );
});

describe("parity: D7 .via()", () => {
  test(
    "walks + inverse arms, listed through each system; both engines match the contract",
    () => runFixture(d7Via, { oracle: true }),
    TIMEOUT,
  );
});

describe("parity: S6 tier ladder", () => {
  test(
    "a group at admin lets its plain members operate; a group at viewer does not; both engines match the contract",
    () => runFixture(s6Ladder, { oracle: true }),
    TIMEOUT,
  );
});

describe("parity: random add/remove over the appSchema universe", () => {
  for (const seed of [7, 42, 1337])
    test(
      `seed ${seed}: 40 ops, compared every 10`,
      () => runFixture(randomFixture(seed)),
      TIMEOUT,
    );
});

// ---------------------------------------------------------------------------
// The harness's own anchors: the oracle states the contract's headline answers.
// These run without the engine, so a red parity run is never a red harness.
// ---------------------------------------------------------------------------

describe("oracle sanity (CONTRACT §2, no engine)", () => {
  const oracleAfter = (f: Fixture, steps: number) => {
    const log = new FactLog();
    for (const step of f.steps.slice(0, steps))
      for (const op of step.ops) log.apply(op);
    return new Oracle(f.schema, log.all(), f.nodes);
  };
  const n = (type: string, id: string) => ({ type, id });

  test("D1: the typed intermediate", () => {
    const o = oracleAfter(d1TypedIntermediate, 4);
    expect(o.check(n("system_user", "ana"), "operate", n("device", "d1"))).toBe(
      true,
    );
    expect(o.check(n("system_user", "bo"), "operate", n("device", "d1"))).toBe(
      false,
    );
    expect(o.check(n("system_user", "cy"), "operate", n("device", "d1"))).toBe(
      true,
    );
  });

  test("D2: derived rows are never a first hop", () => {
    const o = oracleAfter(d2FirstHopFacts, 5);
    expect(o.listSubjects(n("doc", "doc1"), "reader", "group")).toEqual([
      "g1",
      "g2",
    ]);
    expect(o.listSubjects(n("doc", "doc1"), "reader", "user")).toEqual(["u1"]);
  });

  test("S6: one fact per tier", () => {
    const o = oracleAfter(s6Ladder, 7);
    const d1 = n("device", "d1");
    expect(o.permissions(n("seat", "m1"), d1)).toEqual(["operate", "view"]);
    expect(o.permissions(n("seat", "m2"), d1)).toEqual(["view"]);
    expect(o.permissions(n("seat", "boss"), d1)).toEqual([
      "manage",
      "operate",
      "view",
    ]);
    expect(o.permissions(n("seat", "sv"), d1)).toEqual(["view"]);
  });

  test("D3: an inverse second hop", () => {
    const o = oracleAfter(d3MixedArms, 4);
    expect(o.listSubjects(n("rule", "r1"), "source", "device")).toEqual([
      "d1",
      "d2",
      "d4",
    ]);
  });

  test("folder tree: recursion is the least fixed point", () => {
    const o = oracleAfter(folderTree, 10);
    const v1 = n("system_user", "v1");
    expect(o.listObjects("group", "view", v1)).toEqual([
      "g1",
      "g2",
      "g3",
      "g4",
      "g5",
      "g6",
    ]);
    expect(o.listObjects("group", "manage", v1)).toEqual([]);
    expect(o.listObjects("group", "manage", n("system_user", "a2"))).toEqual([
      "g2",
      "g3",
      "g4",
    ]);
  });

  test("every materializable arm of every fixture is derived", () => {
    for (const f of [
      appSchema,
      folderTree,
      d1TypedIntermediate,
      d2FirstHopFacts,
      d3MixedArms,
      d6Inherits,
      d7Via,
      s6Ladder,
    ])
      expect(
        deriveSchemas(f.schema).materializedArms.length,
        f.name,
      ).toBeGreaterThan(0);
  });
});
