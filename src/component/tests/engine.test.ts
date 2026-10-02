/**
 * EXPANSION.md P1 (idempotence), P5 (depth), P6 (rebuild: retired rules,
 * upstream edits, a lowered maxDepth, the paths cap), Lemma Q (the active
 * config: rollbacks rebuild, stale cursors are dropped, old paths never block
 * the cap), and the seed guarantee (CONTRACT §5.3). Configs are written by hand, or compiled where the claim
 * is about the compiler's keys.
 */
import { zbarEngineTest } from "../../test";
import type { WorkId } from "@convex-dev/workpool";
import { describe, expect, test } from "vitest";
import { createZbarSchema, materialize } from "../../client/index";
import {
  ALL_RULES,
  MANAGE,
  ORG,
  TEAM,
  type Task,
  drain,
  engine,
  expectExact,
  graphConfig,
  parked,
  portable,
  rule,
  runTask,
  snapshot,
} from "../../client/tests/expansion-harness";
import { api, internal } from "../_generated/api";
import {
  deleteFact,
  execute,
  findFact,
  findRow,
  insertFact,
  type Env,
} from "../expand";
import { parseSchemaToGraphConfig } from "../helpers";
import { MAX_PATHS } from "../paths";

describe("P1 idempotence: a chunk run twice changes nothing", () => {
  test("re-running a parked cursor leaves the table identical, and the drain still matches the reference", async () => {
    const t = zbarEngineTest();
    const z = engine(t, graphConfig(ALL_RULES, { writeBudget: 2 }));
    for (const u of ["u1", "u2", "u3"])
      await z.add(`user:${u}`, "member", "squad:s1");
    await z.add("team:t1", "viewer", "org:o1");
    await drain(t);
    await z.add("squad:s1", "member", "team:t1"); // parks derived work: 3 seats × 2 hops

    // Every cursor of the first few rounds runs twice in a row; each re-run
    // re-parks its continuation, so later rounds also see duplicated cursors.
    for (let round = 0; round < 6; round++) {
      const [task] = await parked(t);
      if (!task) break;
      await runTask(t, task);
      const once = (await snapshot(t)).rows;
      await t.mutation(internal.mutations.continueExpansion, task.args);
      expect((await snapshot(t)).rows).toEqual(once);
    }
    expect((await parked(t)).length).toBeGreaterThan(0);
    await drain(t);
    await expectExact(t, ALL_RULES, 16);
  });
});

describe("P5 depth: bounded by the facts, not by write order", () => {
  const chain = ["g0", "g1", "g2", "g3", "g4", "g5", "g6"];
  type Fact = readonly [string, string, string];
  const parents: Fact[] = chain
    .slice(1)
    .map((g, i) => [`group:${chain[i]}`, "parent", `group:${g}`]);
  const grant: Fact = ["user:u", "manage", "group:g0"];

  async function build(order: Fact[]) {
    const t = zbarEngineTest();
    const z = engine(t, graphConfig([MANAGE], { writeBudget: 2, maxDepth: 4 }));
    for (const f of order) {
      await z.add(...f);
      await drain(t);
    }
    await expectExact(t, [MANAGE], 4);
    return portable(t);
  }

  test("grant first or last: same rows, no path over maxDepth, one depth failure", async () => {
    const forward = await build([grant, ...parents]);
    const backward = await build([...parents].reverse().concat([grant]));
    expect(forward.rows).toEqual(backward.rows);
    // u reaches g0..g3 (lineages of 1..4 facts); g4 would need 5.
    expect(
      forward.rows.filter((r) => r.startsWith("user:u manage")),
    ).toHaveLength(4);
    for (const s of [forward, backward]) {
      expect(s.failures).toHaveLength(1);
      expect(s.failures[0].reason).toBe("depth");
      expect(s.failures[0].cursor.path.baseIds).toHaveLength(5);
    }
  });
});

describe("P6 rebuild", () => {
  test("an arm going from materialized to computed retires exactly its rule; back again restores the reference", async () => {
    const t = zbarEngineTest();
    const both = engine(t, graphConfig([TEAM, ORG]), "A");
    await both.add("user:u1", "member", "squad:s1");
    await both.add("squad:s1", "member", "team:t1");
    await both.add("user:u2", "member", "team:t1");
    await both.add("team:t1", "viewer", "org:o1");
    await both.add("user:u1", "viewer", "org:o1"); // a fact on a row ORG also derives
    await drain(t);
    const before = await expectExact(t, [TEAM, ORG], 16);
    expect(
      before.rows.some((r: any) =>
        r.paths.some((p: any) => p.rule === ORG.key),
      ),
    ).toBe(true);

    // org.viewer's team#member arm becomes computed: config B has no ORG rule.
    const teamOnly = engine(t, graphConfig([TEAM]), "B");
    await teamOnly.rebuild();
    await drain(t);
    const after = await expectExact(t, [TEAM], 16);

    const strip = (rows: any[]) =>
      rows
        .map((r) => ({
          ...r,
          paths: r.paths.filter((p: any) => p.rule !== ORG.key),
        }))
        .filter((r) => r.paths.length > 0);
    expect(after.rows).toEqual(strip(before.rows)); // same documents, ORG paths gone
    expect(
      after.rows.some(
        (r: any) => r.relation === "viewer" && r.subjectKey === "user:u1",
      ),
    ).toBe(true);

    await both.rebuild();
    await drain(t);
    await expectExact(t, [TEAM, ORG], 16);
  });
});

describe("P6 rebuild repairs what a config change or a bound leaves behind", () => {
  // squad → team → org, both materialized. S2 edits only the UPSTREAM arm
  // (team.member now expands squad#admin): org.viewer's own arm and second
  // hop are unchanged, yet every org.viewer row derived through a squad
  // member is wrong under S2.
  const schema = (teamArm: string) =>
    createZbarSchema()
      .entity("user")
      .entity("squad", (e) =>
        e.relation("member", "user").relation("admin", "user"),
      )
      .entity("team", (e) =>
        e.relation("member", "user", materialize(teamArm as "squad#member")),
      )
      .entity("org", (e) => e.relation("viewer", materialize("team#member")))
      .build();
  const compiled = (teamArm: string) => ({
    ...parseSchemaToGraphConfig(schema(teamArm)),
    mockWorkpool: true,
  });

  test("an upstream edit changes the downstream rule key, and rebuild retires the old rows", async () => {
    const s1 = compiled("squad#member");
    const s2 = compiled("squad#admin");
    const orgKey = (c: typeof s1) =>
      c.rules.find((r) => r.objectType === "org")!.key;
    const base = (key: string) => key.slice(0, key.lastIndexOf("@"));
    expect(base(orgKey(s2))).toBe(base(orgKey(s1))); // the arm itself did not change …
    expect(orgKey(s2)).not.toBe(orgKey(s1)); //          … its upstream did

    const t = zbarEngineTest();
    const one = engine(t, s1, "S1");
    await one.add("user:u", "member", "squad:s");
    await one.add("squad:s", "member", "team:t");
    await one.add("team:t", "viewer", "org:o");
    await drain(t);
    await expectExact(t, s1.rules, 16);
    expect(
      (await snapshot(t)).rows.some(
        (r: any) => r.relation === "viewer" && r.subjectKey === "user:u",
      ),
    ).toBe(true);

    await engine(t, s2, "S2").rebuild();
    await drain(t);
    await expectExact(t, s2.rules, 16); // u is no squad admin: no team.member, no org.viewer
    const keys = new Set(s2.rules.map((r) => r.key).concat("fact"));
    for (const r of (await snapshot(t)).rows)
      for (const p of r.paths) expect(keys.has(p.rule)).toBe(true);
  });

  test("rebuild after maxDepth is lowered drops every path over the new bound", async () => {
    const t = zbarEngineTest();
    const deep = engine(t, graphConfig([MANAGE]), "D16");
    await deep.add("user:u", "manage", "group:g0");
    for (let i = 0; i < 5; i++)
      await deep.add(`group:g${i}`, "parent", `group:g${i + 1}`);
    await drain(t);
    expect(
      (await snapshot(t)).rows.some((r: any) =>
        r.paths.some((p: any) => p.baseIds.length > 3),
      ),
    ).toBe(true);

    await engine(t, graphConfig([MANAGE], { maxDepth: 3 }), "D3").rebuild();
    await drain(t);
    await expectExact(t, [MANAGE], 3);
    expect((await snapshot(t)).failures.map((f: any) => f.reason)).toContain(
      "depth",
    );
  });

  test(`a row past ${MAX_PATHS} paths records a failure; an early retraction is repaired by rebuild`, async () => {
    const t = zbarEngineTest();
    const z = engine(t, graphConfig([TEAM]));
    const squads = Array.from(
      { length: MAX_PATHS + 1 },
      (_, i) => `squad:s${String(i).padStart(2, "0")}`,
    );
    for (const s of squads) await z.add(s, "member", "team:t");
    for (const s of squads) await z.add("user:u", "member", s);
    await drain(t);
    const derived = () =>
      snapshot(t).then((x) =>
        x.rows.find(
          (r: any) => r.subjectKey === "user:u" && r.objectKey === "team:t",
        ),
      );
    expect((await derived()).paths).toHaveLength(MAX_PATHS);
    // At least once (the auto-rebuild re-attempts it): only ever 'paths'.
    const reasons = new Set(
      (await snapshot(t)).failures.map((f: any) => f.reason),
    );
    expect(reasons).toEqual(new Set(["paths"]));

    // Remove the squad links of every stored path: the row goes although the
    // refused path's facts all remain (the early retraction CONTRACT §5.2 allows).
    const { facts } = await snapshot(t);
    const stored = new Set(
      (await derived()).paths.flatMap((p: any) => p.baseIds),
    );
    for (const f of facts) {
      if (f.s === "user:u" && stored.has(f.id)) await z.remove(f.s, f.r, f.o);
    }
    await drain(t);
    expect(await derived()).toBeUndefined();

    await z.rebuild();
    await drain(t);
    expect((await derived()).paths).toHaveLength(1);
    await expectExact(t, [TEAM], 16);
  });
});

describe("Lemma Q: the active config decides what the table holds", () => {
  const facts: [string, string, string][] = [
    ["user:u", "member", "squad:s"],
    ["squad:s", "member", "team:t"],
    ["team:t", "viewer", "org:o"],
    ["user:v", "member", "team:t"],
  ];
  const orgPaths = async (t: any) =>
    (await snapshot(t)).rows.flatMap((r: any) =>
      r.paths.filter((p: any) => p.rule === ORG.key),
    );
  const kinds = async (t: any) =>
    (await parked(t)).flatMap((x) => x.args.items.map((i: any) => i.kind));

  // Probe A: switching to a config that is already registered (a rollback)
  // must rebuild under it, in both directions, and leave it exact.
  test("A → B → A: the rollback to A rebuilds, and the ORG rows come back", async () => {
    const t = zbarEngineTest();
    const a = engine(t, graphConfig([TEAM, ORG]), "A");
    const b = engine(t, graphConfig([TEAM]), "B");
    for (const f of facts) await a.add(...f);
    expect(await kinds(t)).not.toContain("rebuild"); // first activation, empty component
    await drain(t);
    await expectExact(t, [TEAM, ORG], 16);
    expect(await orgPaths(t)).not.toEqual([]);

    await b.add(...facts[0]); // first write under B (an idempotent add)
    expect(await kinds(t)).toEqual(["rebuild"]);
    await drain(t);
    await expectExact(t, [TEAM], 16);
    expect(await orgPaths(t)).toEqual([]);

    await a.add(...facts[0]); // roll back: A is registered already, yet it is not active
    expect(await kinds(t)).toEqual(["rebuild"]);
    await drain(t);
    await expectExact(t, [TEAM, ORG], 16);
    expect(await orgPaths(t)).not.toEqual([]);
    expect((await snapshot(t)).failures).toEqual([]);
  });

  test("B → A → B: the rollback to B leaves no stale ORG row", async () => {
    const t = zbarEngineTest();
    const a = engine(t, graphConfig([TEAM, ORG]), "A");
    const b = engine(t, graphConfig([TEAM]), "B");
    for (const f of facts) await b.add(...f);
    await drain(t);
    await expectExact(t, [TEAM], 16);

    await a.add(...facts[0]);
    await drain(t);
    await expectExact(t, [TEAM, ORG], 16);
    expect(await orgPaths(t)).not.toEqual([]);

    await b.add(...facts[0]);
    expect(await kinds(t)).toEqual(["rebuild"]);
    await drain(t);
    await expectExact(t, [TEAM], 16);
    expect(await orgPaths(t)).toEqual([]);
  });

  test("facts but no active row (written before the row existed): the first write rebuilds", async () => {
    const t = zbarEngineTest();
    const a = engine(t, graphConfig([TEAM, ORG]), "A");
    for (const f of facts) await a.add(...f);
    await drain(t);
    await t.run(async (ctx: any) => {
      for (const r of await ctx.db.query("activeConfig").collect())
        await ctx.db.delete(r._id);
    });
    await a.add(...facts[0]);
    expect(await kinds(t)).toEqual(["rebuild"]);
  });

  // Probe B: C1 derives (u viewer o) from {a, b}; C2 only from {a, b, c}. A
  // C1 add/second cursor parked before C2 became active must not run, before
  // or after C2's retire passes the row: run, its old `isCurrent` prunes C2's
  // superset path {a,b,c} and stores {a,b} under a key C2 does not know.
  const ORG_ADMIN = rule({
    objectType: "org",
    derived: "admin",
    firstHop: "admin",
    intermediateType: "team",
    relations: ["member"],
    target: "admin",
  });
  const VIP = rule({
    objectType: "team",
    derived: "vip",
    firstHop: "member",
    intermediateType: "user",
    relations: ["self"],
    target: "vip",
  });
  const ORG_VIP = rule({
    objectType: "org",
    derived: "viewer",
    firstHop: "viewer",
    intermediateType: "team",
    relations: ["vip"],
    target: "vip",
  });
  const C1 = [ORG_ADMIN, ORG];
  const C2 = [VIP, ORG_VIP];

  /** Run parked cursors, never one matching `hold`, until only those are left. */
  async function drainExcept(t: any, hold: (task: Task) => boolean) {
    for (let i = 0; i < 10_000; i++) {
      const next = (await parked(t)).find((x) => !hold(x));
      if (!next) return;
      await runTask(t, next);
    }
    throw new Error("drainExcept did not terminate");
  }

  for (const when of ["before", "after"] as const) {
    test(`a parked C1 cursor run ${when} C2's retire passes the row writes nothing, and nothing is recorded`, async () => {
      const t = zbarEngineTest();
      const c1 = engine(t, graphConfig(C1, { writeBudget: 1 }), "C1");
      const c2 = engine(t, graphConfig(C2, { writeBudget: 1 }), "C2");
      await c1.add("team:t", "viewer", "org:o"); // b
      await drain(t);
      await c1.add("user:u", "member", "team:t"); // a: ORG_ADMIN's item runs, ORG's is parked
      const [old] = await parked(t);
      expect(old.args).toMatchObject({
        configHash: "C1",
        items: [{ kind: "add", trigger: "second", rule: ORG.key }],
      });

      await c2.add("user:u", "self", "user:u"); // c: C2 becomes active
      const isOld = (x: Task) => x._id === old._id;
      const isRetire = (x: Task) =>
        x.args.items.some(
          (i: any) => i.kind === "rebuild" && i.phase === "retire",
        );
      await drainExcept(
        t,
        when === "before" ? (x) => isOld(x) || isRetire(x) : isOld,
      );
      if (when === "before") {
        expect((await parked(t)).some(isRetire)).toBe(true);
        const row = (await snapshot(t)).rows.find(
          (r: any) => r.subjectKey === "user:u" && r.relation === "viewer",
        );
        expect(row.paths.map((p: any) => p.rule)).toEqual([ORG_VIP.key]); // {a,b,c}, which C1 would prune
      }
      const before = (await snapshot(t)).rows;
      await runTask(t, old);
      expect((await snapshot(t)).rows).toEqual(before);

      await drain(t);
      await expectExact(t, C2, 16);
      expect((await snapshot(t)).failures).toEqual([]);
    });
  }

  test("a stale cursor is dropped by chunkCompleted and resumeExpansion, not retried or recorded", async () => {
    const t = zbarEngineTest();
    const c1 = engine(t, graphConfig(C1), "C1");
    const c2 = engine(t, graphConfig(C2), "C2");
    await c1.add("team:t", "viewer", "org:o");
    await c2.add("team:t", "viewer", "org:o"); // C2 active
    await drain(t);
    const cursor = {
      items: [
        {
          kind: "add" as const,
          trigger: "second" as const,
          row: {
            subjectKey: "user:u",
            relation: "member",
            objectKey: "team:t",
          },
          rule: ORG.key,
          paths: [],
          after: null,
        },
      ],
      configHash: "C1",
      budget: 1,
      attempts: 4, // one more failure would record it, were it not stale
    };
    await t.mutation(internal.mutations.chunkCompleted, {
      workId: "w" as WorkId,
      context: cursor,
      result: { kind: "failed", error: "boom" },
    });
    expect((await snapshot(t)).failures).toEqual([]);

    const failureId = await t.run(async (ctx: any) =>
      ctx.db.insert("expansionFailures", {
        cursor,
        reason: "failed",
        error: "boom",
        attempts: 5,
        createdAt: 0,
      }),
    );
    await t.mutation(api.mutations.resumeExpansion, { failureId });
    expect((await snapshot(t)).failures).toEqual([]);
    expect(await parked(t)).toEqual([]);
  });

  // Probe C: 32 paths of the old config fill the row; the new config derives
  // it once. Old paths never count against the cap, so the one auto-rebuild
  // stores the new path (evicting an old one) and retires the rest.
  test(`${MAX_PATHS} old-config paths on a row never block the new config's path`, async () => {
    const t = zbarEngineTest();
    const ORG_SQUAD = rule({
      objectType: "org",
      derived: "viewer",
      firstHop: "viewer",
      intermediateType: "squad",
      relations: ["member"],
      target: "squad",
    });
    const old = engine(t, graphConfig([ORG]), "OLD");
    const next = engine(t, graphConfig([ORG_SQUAD], { writeBudget: 2 }), "NEW");
    for (let i = 0; i < MAX_PATHS; i++) {
      const team = `team:t${String(i).padStart(2, "0")}`;
      await old.add("user:u", "member", team);
      await old.add(team, "viewer", "org:o");
    }
    await old.add("user:u", "member", "squad:s");
    await old.add("squad:s", "viewer", "org:o");
    await drain(t);
    const row = async () =>
      (await snapshot(t)).rows.find(
        (r: any) =>
          r.subjectKey === "user:u" &&
          r.relation === "viewer" &&
          r.objectKey === "org:o",
      );
    expect((await row()).paths).toHaveLength(MAX_PATHS);
    expect((await snapshot(t)).failures).toEqual([]);

    await next.add("user:u", "member", "squad:s"); // NEW becomes active: one auto-rebuild
    expect(await kinds(t)).toEqual(["rebuild"]);
    // Before retire: the new path is stored and an old one evicted (P7: never over the cap).
    const isRetire = (x: Task) =>
      x.args.items.some(
        (i: any) => i.kind === "rebuild" && i.phase === "retire",
      );
    await drainExcept(t, isRetire);
    expect((await parked(t)).some(isRetire)).toBe(true);
    const mid = (await row()).paths.map((p: any) => p.rule);
    expect(mid).toHaveLength(MAX_PATHS);
    expect(mid).toContain(ORG_SQUAD.key);
    await drain(t);
    expect((await row()).paths.map((p: any) => p.rule)).toEqual([
      ORG_SQUAD.key,
    ]);
    expect((await snapshot(t)).failures).toEqual([]);
    await expectExact(t, [ORG_SQUAD], 16);
  });
});

describe("the seed is in the caller transaction", () => {
  test("a read later in the same mutation sees the fact and its mirror, and not after deleteFact", async () => {
    const t = zbarEngineTest();
    const config = graphConfig([TEAM, ORG], { writeBudget: 1 });
    await t.run(async (ctx: any) => {
      const env: Env = { config, configHash: "seed", budget: 1 };
      const s = { type: "squad", id: "s1" };
      const tm = { type: "team", id: "t1" };
      const mirror = {
        subjectKey: "squad:s1",
        relation: "member",
        objectKey: "team:t1",
      };

      await insertFact(ctx, env, {
        subject: { type: "user", id: "u1" },
        relation: "member",
        object: s,
      });
      const { id, items } = await insertFact(ctx, env, {
        subject: s,
        relation: "member",
        object: tm,
      });
      await execute(ctx, env, items);
      expect(await findFact(ctx, s, "member", tm)).not.toBeNull();
      expect((await findRow(ctx, mirror))?.paths).toEqual([
        { baseIds: [id], rule: "fact" },
      ]);

      const fact = (await findFact(ctx, s, "member", tm))!;
      await execute(ctx, env, (await deleteFact(ctx, fact)).items);
      expect(await findFact(ctx, s, "member", tm)).toBeNull();
      expect(await findRow(ctx, mirror)).toBeNull();
    });
  });
});
