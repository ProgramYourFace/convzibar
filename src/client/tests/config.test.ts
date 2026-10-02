import { zbarEngineTest } from "../../test";
import { expect, test, describe } from "vitest";
import { Zbar, createZbarSchema } from "../index";
import { api } from "../../component/_generated/api";

// ============================================================================
// Compiled-config registry (configs table + configHash on every write).
//
// The client keeps a per-instance "my config is registered" flag so it can
// ship only the hash after the first write. That flag is client-side memory
// of server-side state, and the two can diverge: the registering transaction
// can roll back after the flag flips (parent mutation throws, OCC retry), or
// component data can be wiped/restored while a warm isolate still holds the
// instance. These tests pin down registration, hash-only steady state, and
// recovery from a stale flag.
// ============================================================================

const setup = zbarEngineTest;

const zbarSchema = createZbarSchema()
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .permission("manage", "admin"),
  )
  .build();

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

const mkZbar = () => new Zbar(api, { schema: zbarSchema });

const u1 = { type: "user", id: "u1" } as const;
const u2 = { type: "user", id: "u2" } as const;
const org = { type: "org", id: "org1" } as const;

const configRows = (t: any) =>
  t.run(async (ctx: any) => await ctx.db.query("configs").collect());

describe("compiled-config registry", () => {
  test("first write registers the config once; later writes are hash-only", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    expect(await configRows(t)).toHaveLength(0);

    await zbar.addRelation(ctx, u1, "owner", org);
    const rows = await configRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(zbar.configHash);

    // Steady state: more writes don't duplicate the row.
    await zbar.addRelation(ctx, u2, "admin", org);
    await zbar.removeRelation(ctx, u2, "admin", org);
    expect(await configRows(t)).toHaveLength(1);
  });

  test("a second instance with the same schema reuses the registration", async () => {
    const t = setup();
    const ctx = mkCtx(t);

    const a = mkZbar();
    const b = mkZbar();
    expect(a.configHash).toBe(b.configHash);

    await a.addRelation(ctx, u1, "owner", org);
    await b.addRelation(ctx, u2, "admin", org);
    expect(await configRows(t)).toHaveLength(1);

    expect(await b.can(ctx, u1, "manage", org)).toBe(true);
    expect(await b.can(ctx, u2, "manage", org)).toBe(true);
  });

  test("writes self-heal when the registered config row disappears", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    await zbar.addRelation(ctx, u1, "owner", org);
    expect(await configRows(t)).toHaveLength(1);

    // Simulate stale client-side registration state: the config row is gone
    // (rolled-back registering transaction, wiped/restored component data)
    // but this instance still believes it registered.
    await t.run(async (innerCtx: any) => {
      for (const row of await innerCtx.db.query("configs").collect()) {
        await innerCtx.db.delete(row._id);
      }
    });
    expect(await configRows(t)).toHaveLength(0);

    // Every write kind must recover by re-registering, not throw.
    await zbar.addRelation(ctx, u2, "admin", org);
    expect(await configRows(t)).toHaveLength(1);
    expect(await zbar.can(ctx, u2, "manage", org)).toBe(true);

    await t.run(async (innerCtx: any) => {
      for (const row of await innerCtx.db.query("configs").collect()) {
        await innerCtx.db.delete(row._id);
      }
    });
    await zbar.removeRelation(ctx, u2, "admin", org);
    expect(await zbar.can(ctx, u2, "manage", org)).toBe(false);
    expect(await configRows(t)).toHaveLength(1);
  });
});
