/**
 * EXPANSION.md P4 (liveness) under the REAL workpool: a chunk that keeps
 * failing is retried with half its budget, recorded in `expansionFailures`
 * with its exact cursor after 5 attempts, and `resumeExpansion` completes it.
 */
import { zbarEngineTest } from "../../test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../component/_generated/api";
import {
  TEAM,
  engine,
  expectExact,
  graphConfig,
  snapshot,
} from "./expansion-harness";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = (t: any) => t.finishAllScheduledFunctions(vi.runAllTimers, 1000);

describe("P4 liveness: every expansion drains or is recorded", () => {
  test("a chunk failing 5 times lands in expansionFailures with its cursor; resumeExpansion completes it", async () => {
    const t = zbarEngineTest();
    const config = graphConfig([TEAM], { writeBudget: 1, mock: false });
    const z = engine(t, config, "p4");
    for (const u of ["u1", "u2", "u3"])
      await z.add(`user:${u}`, "member", "squad:s");
    await z.add("squad:s", "member", "team:t"); // one row inline, the rest continues by cursor

    // Make every continuation fail: its config hash is no longer registered.
    await t.run(async (ctx: any) => {
      for (const c of await ctx.db.query("configs").collect())
        await ctx.db.delete(c._id);
    });
    await settle(t);

    // One chunk was in flight (a first registration enqueues no rebuild):
    // the add continuation. It failed 5 times and is recorded.
    const failures = await t.query(api.queries.listExpansionFailures, {});
    expect(
      failures.map((f: any) => f.cursor.items.map((i: any) => i.kind)),
    ).toEqual([["add"]]);
    const failure = failures[0];
    expect(failure.reason).toBe("failed");
    expect(failure.attempts).toBe(5);
    expect(failure.error).toContain("not registered");
    expect(failure.cursor.items[0]).toMatchObject({
      kind: "add",
      trigger: "first",
      rule: TEAM.key,
    });
    expect(failure.cursor.budget).toBe(1); // halved down to the floor
    const derived = (await snapshot(t)).rows.filter(
      (r: any) => r.objectKey === "team:t" && r.subjectKey.startsWith("user:"),
    );
    expect(derived).toHaveLength(1); // nothing was silently written or dropped

    // Fix the cause, resume both: the expansion completes and the records are gone.
    await t.run(async (ctx: any) =>
      ctx.db.insert("configs", { hash: "p4", config }),
    );
    for (const f of failures)
      await t.mutation(api.mutations.resumeExpansion, { failureId: f._id });
    await settle(t);
    expect(await t.query(api.queries.listExpansionFailures, {})).toEqual([]);
    await expectExact(t, [TEAM], 16);
  });

  test("a depth failure is recorded, not resumable", async () => {
    const t = zbarEngineTest();
    const z = engine(
      t,
      graphConfig([TEAM], { maxDepth: 1, mock: false }),
      "depth",
    );
    await z.add("user:u", "member", "squad:s");
    await z.add("squad:s", "member", "team:t");
    const [failure] = await t.query(api.queries.listExpansionFailures, {});
    expect(failure.reason).toBe("depth");
    await expect(
      t.mutation(api.mutations.resumeExpansion, { failureId: failure._id }),
    ).rejects.toThrow(/not a continuation/);
  });
});
