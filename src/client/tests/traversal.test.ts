import { zbarEngineTest } from "../../test";
import { api } from "../../component/_generated/api";
import { describe, expect, test } from "vitest";
import { Zbar, createZbarSchema, materialize } from "../index";

// ============================================================================
// Read-planner invariants (CONTRACT.md §3–§4), each on a minimal schema.
//
// Facts are seeded straight into the component tables together with the
// mirror row the BFS writes for every fact, and — where a test covers a
// materialized arm — the derived rows a caught-up materialization holds. So
// every assertion here is about the READ side alone; write/read parity is
// `parity.test.ts`.
// ============================================================================

type Node = { type: string; id: string };
type Fact = [
  subject: Node,
  relation: string,
  object: Node,
  properties?: unknown,
];
const n = (type: string, id: string): Node => ({ type, id });
const sorted = (xs: Iterable<string>) => [...xs].sort();

function setup(schema: any, options: { maxDepth?: number } = {}) {
  const t = zbarEngineTest();
  const ctx = {
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  } as any;
  const zbar: any = new Zbar(api, { schema, ...options });
  return { t, ctx, zbar };
}

async function seed(t: any, facts: Fact[], derived: Fact[] = []) {
  await t.run(async (c: any) => {
    const ids: string[] = [];
    for (const [s, relation, o, properties] of facts) {
      const id = await c.db.insert("relationships", {
        subjectType: s.type,
        subjectId: s.id,
        relation,
        objectType: o.type,
        objectId: o.id,
        ...(properties === undefined ? {} : { properties }),
      });
      ids.push(id);
      await c.db.insert("effectiveRelationships", {
        subjectKey: `${s.type}:${s.id}`,
        relation,
        objectKey: `${o.type}:${o.id}`,
        paths: [{ baseIds: [id], rule: "fact" }],
      });
    }
    for (const [s, relation, o] of derived) {
      await c.db.insert("effectiveRelationships", {
        subjectKey: `${s.type}:${s.id}`,
        relation,
        objectKey: `${o.type}:${o.id}`,
        paths: [{ baseIds: [...ids].sort(), rule: "test:materialized" }],
      });
    }
  });
}

type SetRef = { relation: string } | { permission: string };
const pick = (q: any, set: SetRef) =>
  "relation" in set ? q.relation(set.relation) : q.permission(set.permission);

async function objectsOf(
  zbar: any,
  ctx: any,
  type: string,
  set: SetRef,
  s: Node,
  via?: Node[],
) {
  let q = pick(zbar.list().object(type), set).subject(s);
  if (via) q = q.via(...via);
  return sorted((await q.collect(ctx)).map((r: any) => r.objectId));
}

async function subjectsOf(
  zbar: any,
  ctx: any,
  o: Node,
  set: SetRef,
  type: string,
  via?: Node[],
) {
  let q = pick(zbar.list().object(o), set).subject(type);
  if (via) q = q.via(...via);
  return sorted((await q.collect(ctx)).map((r: any) => r.subjectId));
}

async function directOf(zbar: any, ctx: any, o: Node, relation: string) {
  const rows = await zbar
    .listDirect()
    .object(o)
    .relation(relation)
    .collect(ctx);
  return sorted(
    rows.map(
      (r: any) =>
        `${r.subject.type}:${r.subject.id} ${r.relation} ${r.object.type}:${r.object.id}`,
    ),
  );
}

/**
 * The set `(objectType, name)` over `subjects × objects` must be exactly
 * `expected` (pairs `[subjectId, objectId]`) for `can` (through permission
 * `p ⊇ name`), `hasRelationship`, `list` forward and `list` reverse.
 */
async function assertExactSet(
  zbar: any,
  ctx: any,
  set: { objectType: string; name: string; subjectType: string },
  subjects: string[],
  objects: string[],
  expected: [string, string][],
) {
  const want = new Set(expected.map(([s, o]) => `${s}|${o}`));
  for (const s of subjects) {
    const subject = n(set.subjectType, s);
    for (const o of objects) {
      const object = n(set.objectType, o);
      const label = `${s} ∈ ${o}.${set.name}`;
      expect(await zbar.can(ctx, subject, "p", object), label).toBe(
        want.has(`${s}|${o}`),
      );
      expect(
        await zbar.hasRelationship(ctx, subject, set.name, object),
        label,
      ).toBe(want.has(`${s}|${o}`));
    }
    expect(
      await objectsOf(
        zbar,
        ctx,
        set.objectType,
        { relation: set.name },
        subject,
      ),
    ).toEqual(sorted(objects.filter((o) => want.has(`${s}|${o}`))));
  }
  for (const o of objects) {
    expect(
      await subjectsOf(
        zbar,
        ctx,
        n(set.objectType, o),
        { relation: set.name },
        set.subjectType,
      ),
    ).toEqual(sorted(subjects.filter((s) => want.has(`${s}|${o}`))));
  }
}

// ---------------------------------------------------------------------------
// (a) Each arm kind in isolation yields exactly its defined set.
// ---------------------------------------------------------------------------

describe("(a) each arm kind yields exactly its defined set", () => {
  test("facts: the subjects written to the set", async () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("doc", (e) => e.relation("r", "user").permission("p", "r"))
      .build();
    const { t, ctx, zbar } = setup(schema);
    await seed(t, [[n("user", "u1"), "r", n("doc", "d1")]]);
    await assertExactSet(
      zbar,
      ctx,
      { objectType: "doc", name: "r", subjectType: "user" },
      ["u1", "u2"],
      ["d1", "d2"],
      [["u1", "d1"]],
    );
    expect(await directOf(zbar, ctx, n("doc", "d1"), "r")).toEqual([
      "user:u1 r doc:d1",
    ]);
  });

  test("inherits: everything in the inherited set, never a row", async () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("doc", (e) =>
        e
          .relation("owner", "user")
          .relation("r", "owner", "user")
          .permission("p", "r"),
      )
      .build();
    const { t, ctx, zbar } = setup(schema);
    await seed(t, [
      [n("user", "u1"), "owner", n("doc", "d1")],
      [n("user", "u2"), "r", n("doc", "d1")],
    ]);
    await assertExactSet(
      zbar,
      ctx,
      { objectType: "doc", name: "r", subjectType: "user" },
      ["u1", "u2", "u3"],
      ["d1"],
      [
        ["u1", "d1"],
        ["u2", "d1"],
      ],
    );
    // listDirect of `r` reads the writable members of its closure: the facts.
    expect(await directOf(zbar, ctx, n("doc", "d1"), "r")).toEqual([
      "user:u1 owner doc:d1",
      "user:u2 r doc:d1",
    ]);
  });

  test("expands: the far set of each group written to this set", async () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("group", (e) => e.relation("member", "user"))
      .entity("doc", (e) =>
        e.relation("r", "group#member").permission("p", "r"),
      )
      .build();
    const { t, ctx, zbar } = setup(schema);
    await seed(t, [
      [n("group", "g1"), "r", n("doc", "d1")],
      [n("user", "u1"), "member", n("group", "g1")],
      [n("user", "u2"), "member", n("group", "g2")],
    ]);
    await assertExactSet(
      zbar,
      ctx,
      { objectType: "doc", name: "r", subjectType: "user" },
      ["u1", "u2"],
      ["d1", "d2"],
      [["u1", "d1"]],
    );
    // The group itself is a fact of the set (expands imply their type).
    expect(
      await subjectsOf(zbar, ctx, n("doc", "d1"), { relation: "r" }, "group"),
    ).toEqual(["g1"]);
    expect(await directOf(zbar, ctx, n("doc", "d1"), "r")).toEqual([
      "group:g1 r doc:d1",
    ]);
  });

  test("walks: the far set of each object in the via relation", async () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("folder", (e) => e.relation("viewer", "user"))
      .entity("doc", (e) =>
        e
          .relation("parent", "folder")
          .relation("r", "parent.viewer")
          .permission("p", "r"),
      )
      .build();
    const { t, ctx, zbar } = setup(schema);
    await seed(t, [
      [n("folder", "f1"), "parent", n("doc", "d1")],
      [n("user", "u1"), "viewer", n("folder", "f1")],
      [n("user", "u2"), "viewer", n("folder", "f2")],
    ]);
    await assertExactSet(
      zbar,
      ctx,
      { objectType: "doc", name: "r", subjectType: "user" },
      ["u1", "u2"],
      ["d1", "d2"],
      [["u1", "d1"]],
    );
    expect(await directOf(zbar, ctx, n("doc", "d1"), "r")).toEqual([]);
  });

  test("inverse: exactly the nodes of the named type whose fact points at this object", async () => {
    const schema = createZbarSchema()
      .entity("system", (e) =>
        e.relation("r", "~device#parent").permission("p", "r"),
      )
      .entity("device", (e) => e.relation("parent", "system"))
      .entity("group", (e) => e.relation("parent", "system"))
      .build();
    const { t, ctx, zbar } = setup(schema);
    await seed(t, [
      [n("system", "s1"), "parent", n("device", "d1")],
      [n("system", "s1"), "parent", n("device", "d2")],
      [n("system", "s2"), "parent", n("device", "d3")],
      // Same relation name on another type: not a member (typed graph).
      [n("system", "s1"), "parent", n("group", "g1")],
    ]);
    await assertExactSet(
      zbar,
      ctx,
      { objectType: "system", name: "r", subjectType: "device" },
      ["d1", "d2", "d3"],
      ["s1", "s2"],
      [
        ["d1", "s1"],
        ["d2", "s1"],
        ["d3", "s2"],
      ],
    );
    expect(
      await subjectsOf(
        zbar,
        ctx,
        n("system", "s1"),
        { relation: "r" },
        "group",
      ),
    ).toEqual([]);
    expect(await zbar.can(ctx, n("group", "g1"), "p", n("system", "s1"))).toBe(
      false,
    );
    // listDirect returns the underlying facts flipped onto the set.
    expect(await directOf(zbar, ctx, n("system", "s1"), "r")).toEqual([
      "device:d1 r system:s1",
      "device:d2 r system:s1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (b) The first hop reads facts only.
// ---------------------------------------------------------------------------

test("(b) a derived row never acts as a first hop", async () => {
  // doc.parent gains the grandparent folder as a DERIVED row (materialized
  // `folder#parent`); `doc.viewer ⊇ parent.viewer` must still hop only through
  // the FACT parent. Zanzibar's tupleToUserset reads tuples, never usersets.
  const schema = createZbarSchema()
    .entity("user")
    .entity("folder", (e) =>
      e.relation("parent", "folder").relation("viewer", "user"),
    )
    .entity("doc", (e) =>
      e
        .relation("parent", "folder", materialize("folder#parent"))
        .relation("viewer", "user", "parent.viewer")
        .permission("view", "viewer"),
    )
    .build();
  const { t, ctx, zbar } = setup(schema);
  const [doc, f, g] = [n("doc", "doc"), n("folder", "f"), n("folder", "g")];
  const [alice, bob] = [n("user", "alice"), n("user", "bob")];
  await seed(
    t,
    [
      [f, "parent", doc],
      [g, "parent", f],
      [alice, "viewer", g],
      [bob, "viewer", f],
    ],
    [[g, "parent", doc]], // the materialized arm, caught up
  );

  expect(await zbar.hasRelationship(ctx, g, "parent", doc)).toBe(true); // the row is read as a member
  expect(await zbar.can(ctx, alice, "view", doc)).toBe(false); // but not hopped through
  expect(await zbar.can(ctx, bob, "view", doc)).toBe(true);
  expect(
    await objectsOf(zbar, ctx, "doc", { permission: "view" }, alice),
  ).toEqual([]);
  expect(
    await subjectsOf(zbar, ctx, doc, { permission: "view" }, "user"),
  ).toEqual(["bob"]);
  expect(await zbar.getPermissions(ctx, alice, doc)).toEqual([]);
});

// ---------------------------------------------------------------------------
// (c) Typed intermediates (audit D1).
// ---------------------------------------------------------------------------

test("(c) a seat written to operator is not expanded through the seat`s own viewer", async () => {
  const schema = createZbarSchema()
    .entity("system_user", (e) => e.relation("viewer", "system_user"))
    .entity("group", (e) => e.relation("viewer", "system_user"))
    .entity("device", (e) =>
      e
        .relation("operator", "system_user", "group#viewer")
        .permission("operate", "operator"),
    )
    .build();
  const { t, ctx, zbar } = setup(schema);
  const [ana, bo, cy] = ["ana", "bo", "cy"].map((id) => n("system_user", id));
  const [g1, d1] = [n("group", "g1"), n("device", "d1")];
  await seed(t, [
    [ana, "operator", d1],
    [bo, "viewer", ana], // bo views ana's profile: ana is a seat, not a group
    [g1, "operator", d1],
    [cy, "viewer", g1],
  ]);

  expect(await zbar.can(ctx, bo, "operate", d1)).toBe(false);
  expect(await zbar.can(ctx, ana, "operate", d1)).toBe(true);
  expect(await zbar.can(ctx, cy, "operate", d1)).toBe(true);
  expect(
    await objectsOf(zbar, ctx, "device", { permission: "operate" }, bo),
  ).toEqual([]);
  expect(
    await subjectsOf(zbar, ctx, d1, { permission: "operate" }, "system_user"),
  ).toEqual(["ana", "cy"]);
});

// ---------------------------------------------------------------------------
// (d) The `#` first hop includes inherited facts.
// ---------------------------------------------------------------------------

test("(d) a group written at admin makes its members operators when operator ⊇ admin", async () => {
  const schema = createZbarSchema()
    .entity("system_user")
    .entity("group", (e) =>
      e
        .relation("admin", "system_user")
        .relation("viewer", "admin", "system_user"),
    )
    .entity("device", (e) =>
      e
        .relation("admin", "system_user", "group#admin")
        .relation("operator", "admin", "system_user", "group#viewer")
        .permission("operate", "operator")
        .permission("manage", "admin"),
    )
    .build();
  const { t, ctx, zbar } = setup(schema);
  const [fleet, d1] = [n("group", "fleet"), n("device", "d1")];
  const [member, chief, other] = ["member", "chief", "other"].map((id) =>
    n("system_user", id),
  );
  await seed(t, [
    [fleet, "admin", d1], // one containment fact, at admin only
    [member, "viewer", fleet],
    [chief, "admin", fleet],
  ]);

  expect(await zbar.can(ctx, member, "operate", d1)).toBe(true); // first hop of group#viewer reads admin facts
  expect(await zbar.can(ctx, member, "manage", d1)).toBe(false); // group#admin: members are not admins
  expect(await zbar.can(ctx, chief, "manage", d1)).toBe(true);
  expect(await zbar.can(ctx, other, "operate", d1)).toBe(false);
  expect(await zbar.getPermissions(ctx, member, d1)).toEqual(["operate"]);
  expect(await zbar.getPermissions(ctx, chief, d1)).toEqual([
    "operate",
    "manage",
  ]);
  expect(
    await subjectsOf(zbar, ctx, d1, { permission: "operate" }, "system_user"),
  ).toEqual(["chief", "member"]);
  expect(
    await objectsOf(zbar, ctx, "device", { permission: "operate" }, member),
  ).toEqual(["d1"]);
});

// ---------------------------------------------------------------------------
// (e) Recursive sets: exact answers, and a throw (never a truncation) past maxDepth.
// ---------------------------------------------------------------------------

describe("(e) a recursive set (folder tree)", () => {
  const schema = createZbarSchema()
    .entity("user")
    .entity("folder", (e) =>
      e
        .relation("parent", "folder")
        .relation("admin", "user")
        .permission("manage", "admin", "parent.manage"),
    )
    .build();
  const f = [0, 1, 2, 3].map((i) => n("folder", `f${i}`));
  const [alice, bob, carol] = ["alice", "bob", "carol"].map((id) =>
    n("user", id),
  );
  //  f0 ← f1 ← f2 ← f3   (fᵢ is the parent of fᵢ₊₁); alice admins f0, bob admins f2.
  const facts: Fact[] = [
    [f[0], "parent", f[1]],
    [f[1], "parent", f[2]],
    [f[2], "parent", f[3]],
    [alice, "admin", f[0]],
    [bob, "admin", f[2]],
  ];

  test("4 levels answer exactly", async () => {
    const { t, ctx, zbar } = setup(schema);
    await seed(t, facts);
    const managers: Record<string, string[]> = {
      f0: ["alice"],
      f1: ["alice"],
      f2: ["alice", "bob"],
      f3: ["alice", "bob"],
    };
    for (const folder of f) {
      for (const u of [alice, bob, carol]) {
        expect(
          await zbar.can(ctx, u, "manage", folder),
          `${u.id} manages ${folder.id}`,
        ).toBe(managers[folder.id].includes(u.id));
      }
      expect(
        await subjectsOf(zbar, ctx, folder, { permission: "manage" }, "user"),
      ).toEqual(managers[folder.id]);
    }
    expect(
      await objectsOf(zbar, ctx, "folder", { permission: "manage" }, alice),
    ).toEqual(["f0", "f1", "f2", "f3"]);
    expect(
      await objectsOf(zbar, ctx, "folder", { permission: "manage" }, bob),
    ).toEqual(["f2", "f3"]);
    expect(
      await objectsOf(zbar, ctx, "folder", { permission: "manage" }, carol),
    ).toEqual([]);
  });

  test("a cycle in the facts terminates (visited set)", async () => {
    const { t, ctx, zbar } = setup(schema);
    await seed(t, [...facts, [f[3], "parent", f[0]]]);
    expect(await zbar.can(ctx, bob, "manage", f[0])).toBe(true);
    expect(await zbar.can(ctx, carol, "manage", f[0])).toBe(false);
    expect(
      await objectsOf(zbar, ctx, "folder", { permission: "manage" }, bob),
    ).toEqual(["f0", "f1", "f2", "f3"]);
  });

  test("past maxDepth: a hit found beyond the bound throws; a walk that finds no hit answers no", async () => {
    // maxDepth bounds the facts in one derivation: k walks + the admin fact.
    const { t, ctx, zbar } = setup(schema, { maxDepth: 3 });
    await seed(t, facts);
    // Within the bound: answered.
    expect(await zbar.can(ctx, alice, "manage", f[2])).toBe(true); // 2 walks, 3 facts
    expect(await zbar.can(ctx, bob, "manage", f[3])).toBe(true); // 1 walk, 2 facts
    // alice on f3 needs 3 walks + 1 = 4 facts: found, too long — refused, never a silent false.
    await expect(zbar.can(ctx, alice, "manage", f[3])).rejects.toThrow(
      /maxDepth/,
    );
    await expect(
      objectsOf(zbar, ctx, "folder", { permission: "manage" }, alice),
    ).rejects.toThrow(/maxDepth/);
    await expect(
      subjectsOf(zbar, ctx, f[3], { permission: "manage" }, "user"),
    ).rejects.toThrow(/maxDepth/);
    // carol's walk reaches the step bound with no hit at all: no, not an error.
    expect(await zbar.can(ctx, carol, "manage", f[3])).toBe(false);
    expect(
      await objectsOf(zbar, ctx, "folder", { permission: "manage" }, carol),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (f) .via() = full list ∩ structural scope.
// ---------------------------------------------------------------------------

test("(f) .via() returns exactly the full list intersected with the structural scope", async () => {
  const schema = createZbarSchema()
    .entity("user")
    .entity("system", (e) =>
      e
        .relation("admin", "user")
        .relation("devices", "~device#parent")
        .relation("groups", "~group#parent"),
    )
    .entity("group", (e) =>
      e.relation("parent", "system").relation("viewer", "user"),
    )
    .entity("device", (e) =>
      e
        .relation("parent", "system")
        .relation("viewer", "user", "group#viewer", "parent.admin")
        .permission("view", "viewer"),
    )
    .build();
  const { t, ctx, zbar } = setup(schema);
  const [s1, s2] = [n("system", "s1"), n("system", "s2")];
  const [g1, g2] = [n("group", "g1"), n("group", "g2")];
  const d = [1, 2, 3].map((i) => n("device", `d${i}`));
  const [alice, bob, carol] = ["alice", "bob", "carol"].map((id) =>
    n("user", id),
  );
  await seed(t, [
    [s1, "parent", d[0]],
    [s1, "parent", d[1]],
    [s2, "parent", d[2]],
    [s1, "parent", g1],
    [alice, "admin", s1],
    [alice, "viewer", d[2]], // a direct grant outside s1
    [g1, "viewer", d[1]],
    [g1, "viewer", d[2]],
    [bob, "viewer", g1],
  ]);

  // Structural scope, by hand from the facts: a fact between the via and the node.
  const scope: Record<string, string[]> = {
    s1: ["d1", "d2"],
    s2: ["d3"],
    g1: ["d2", "d3"],
    g2: [],
  };
  const userScope: Record<string, string[]> = {
    s1: ["alice"],
    s2: [],
    g1: ["bob"],
    g2: [],
  };
  for (const u of [alice, bob, carol]) {
    const full = await objectsOf(
      zbar,
      ctx,
      "device",
      { permission: "view" },
      u,
    );
    for (const via of [s1, s2, g1, g2]) {
      expect(
        await objectsOf(zbar, ctx, "device", { permission: "view" }, u, [via]),
        `${u.id} via ${via.id}`,
      ).toEqual(full.filter((id) => scope[via.id].includes(id)));
    }
  }
  expect(
    await objectsOf(zbar, ctx, "device", { permission: "view" }, alice),
  ).toEqual(["d1", "d2", "d3"]);
  expect(
    await objectsOf(zbar, ctx, "device", { permission: "view" }, alice, [s2]),
  ).toEqual(["d3"]);

  for (const dev of d) {
    const full = await subjectsOf(
      zbar,
      ctx,
      dev,
      { permission: "view" },
      "user",
    );
    for (const via of [s1, s2, g1, g2]) {
      expect(
        await subjectsOf(zbar, ctx, dev, { permission: "view" }, "user", [via]),
      ).toEqual(full.filter((id) => userScope[via.id].includes(id)));
    }
  }

  // A chain: the vias must be structurally linked (g1 ~ s1 by g1's parent fact).
  expect(
    await objectsOf(zbar, ctx, "device", { permission: "view" }, alice, [
      g1,
      s1,
    ]),
  ).toEqual(["d1", "d2"]);
  expect(
    await objectsOf(zbar, ctx, "device", { permission: "view" }, alice, [
      g2,
      s1,
    ]),
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// (g) getPermissions equals per-permission can.
// ---------------------------------------------------------------------------

test("(g) evaluateManyPermissions equals the per-permission can results", async () => {
  const schema = createZbarSchema()
    .entity("user")
    .entity("system", (e) =>
      e.relation("admin", "user").relation("viewer", "admin", "user"),
    )
    .entity(
      "group",
      (e) =>
        e
          .relation("parent", "system")
          .relation("admin", "user")
          .relation("viewer", "admin", "user")
          // Permission walks: system roles reach the group without being members.
          .permission("view", "viewer", "parent.viewer")
          .permission("manage", "admin", "parent.admin")
          .permission("audit", "parent.viewer") // a walk only: no materialised member
          .permission("edit", "manage"), // a permission inheriting a permission
    )
    .build();
  const { t, ctx, zbar } = setup(schema);
  const s1 = n("system", "s1");
  const [g1, g2] = [n("group", "g1"), n("group", "g2")];
  const users = ["sa", "sv", "ga", "gv", "none"].map((id) => n("user", id));
  await seed(t, [
    [s1, "parent", g1],
    [n("user", "sa"), "admin", s1],
    [n("user", "sv"), "viewer", s1],
    [n("user", "ga"), "admin", g1],
    [n("user", "gv"), "viewer", g1],
  ]);
  const perms = ["view", "manage", "audit", "edit"];
  for (const u of users) {
    for (const g of [g1, g2]) {
      const one = [];
      for (const p of perms) if (await zbar.can(ctx, u, p, g)) one.push(p);
      expect(
        await zbar.getPermissions(ctx, u, g),
        `${u.id} on ${g.id}`,
      ).toEqual(one);
    }
  }
  expect(await zbar.getPermissions(ctx, n("user", "sv"), g1)).toEqual([
    "view",
    "audit",
  ]);
  expect(await zbar.getPermissions(ctx, n("user", "sa"), g1)).toEqual([
    "view",
    "manage",
    "audit",
    "edit",
  ]);
  expect(await zbar.getPermissions(ctx, n("user", "gv"), g1)).toEqual(["view"]);
  expect(await zbar.getPermissions(ctx, n("user", "ga"), g1)).toEqual([
    "view",
    "manage",
    "edit",
  ]);
});
