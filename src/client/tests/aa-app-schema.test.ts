import { zbarEngineTest } from "../../test";
import { api } from "../../component/_generated/api";
import { expect, test } from "vitest";
import { schema } from "./fixtures/aa-app-schema";
import { Zbar } from "../index";

// ============================================================================
// The app schema (schemas/zbar.ts) answers a table of EXPECTED reads. Facts
// are seeded directly with their mirror rows, and the materialized `source`
// rows as a caught-up BFS holds them, so this pins the READ side on its own:
// parity.test.ts proves the two engines agree (not what they answer), and
// convex/lib/zbarAccess.test.ts pins the access policy; this pins the rest —
// recipients through `system#member` and `group#seats`, inverse lists,
// `listDirect` flipping an inverse set, a materialized row read with no BFS.
// ============================================================================

type Node = { type: string; id: string };
const n = (type: string, id: string): Node => ({ type, id });

const s1 = n("system", "s1");
const [gA, gB] = [n("group", "gA"), n("group", "gB")];
const [d1, d2, d3] = ["d1", "d2", "d3"].map((id) => n("device", id));
const [rule1, rule2] = [
  n("notification_rule", "rule1"),
  n("notification_rule", "rule2"),
];
const db1 = n("dashboard", "db1");
const lr = n("linked_recipient", "lr1");
// Seats: ow owns s1, ad admins it, vw views it and admins gA, rm is a restricted member of gB.
const [ow, ad, vw, rm] = ["ow", "ad", "vw", "rm"].map((id) =>
  n("system_user", id),
);

const facts: [Node, string, Node, unknown?][] = [
  ...[ow, ad, vw, rm].flatMap((seat) => [
    [s1, "parent", seat] as [Node, string, Node],
    [seat, "self", seat] as [Node, string, Node],
  ]),
  [ow, "owner", s1],
  [ad, "admin", s1],
  [vw, "viewer", s1],
  [s1, "parent", gA],
  [s1, "parent", gB],
  [vw, "admin", gA],
  [rm, "viewer", gB],
  [s1, "parent", d1],
  [s1, "parent", d2],
  [s1, "parent", d3],
  [gA, "admin", d1], // d1: gA at admin, gB at operator
  [gB, "operator", d1],
  [rm, "viewer", d2], // d2: a direct seat grant
  [gB, "viewer", rm], // gB contains rm's seat (group.seats ⊇ ~system_user#viewer)
  [s1, "parent", db1],
  [gA, "viewer", db1],
  [s1, "parent", rule1],
  [s1, "parent", rule2],
  [gA, "source", rule1],
  [s1, "recipient", rule1],
  [d2, "source", rule2],
  [rm, "recipient", rule2, { push: true, email: false }],
  [lr, "recipient", rule2],
];
// The two materialized `source` arms, caught up: gA's devices are {d1}.
const derived: [Node, string, Node][] = [[d1, "source", rule1]];

async function setup() {
  const t = zbarEngineTest();
  const ctx = {
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  } as any;
  const zbar: any = new Zbar(api, { schema });
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
        paths: [{ baseIds: ids, rule: "test:materialized" }],
      });
    }
  });
  return { ctx, zbar };
}

const ids = (rows: any[], key: "objectId" | "subjectId") =>
  rows.map((r) => r[key]).sort();

test("(h) the proposal §2 app schema answers the expected checks", async () => {
  const { ctx, zbar } = await setup();

  const checks: [Node, string, Node, boolean][] = [
    [ow, "manage", s1, true],
    [ad, "manage", s1, false],
    [ad, "manage_resources", s1, true],
    [rm, "view", s1, false],
    [rm, "view_as_member", s1, true], // member ⊇ ~system_user#parent: no tuple
    [vw, "view", d3, true], // parent.viewer
    [vw, "manage", d3, false],
    [vw, "manage", d1, true], // gA admin of d1, vw admin of gA (group#admin)
    [rm, "operate", d1, true], // gB at operator, rm a member of gB (group#viewer)
    [rm, "manage", d1, false],
    [rm, "view", d2, true],
    [rm, "view", d3, false],
    [vw, "view", gB, true], // system viewers see every group, through the permission …
    [vw, "manage", gB, false],
    [ad, "manage", gB, true],
    [rm, "view", vw, false],
    [rm, "view", rm, true], // self
    [ad, "manage", rm, true], // parent.admin on the seat
    [vw, "view", db1, true],
    [rm, "view", db1, false],
    [vw, "manage", db1, false], // authoring is system-admin only
    [ad, "manage", db1, true],
  ];
  for (const [s, p, o, want] of checks) {
    expect(await zbar.can(ctx, s, p, o), `${s.id} ${p} ${o.type}:${o.id}`).toBe(
      want,
    );
  }

  // … but are not its members: `group#viewer` elsewhere expands to members only.
  expect(await zbar.hasRelationship(ctx, vw, "viewer", gB)).toBe(false);
  expect(await zbar.getPermissions(ctx, vw, gA)).toEqual([
    "view",
    "manage",
    "manage_members",
    "configure_as_recipient",
  ]);
  expect(await zbar.getPermissions(ctx, rm, d1)).toEqual(["view", "operate"]);

  // Inverse collections: one facts range each, no stored reverse rows.
  const list = zbar.list();
  expect(
    ids(
      await list.object(s1).relation("devices").subject("device").collect(ctx),
      "subjectId",
    ),
  ).toEqual(["d1", "d2", "d3"]);
  expect(
    ids(
      await zbar
        .list()
        .object(gA)
        .relation("devices")
        .subject("device")
        .collect(ctx),
      "subjectId",
    ),
  ).toEqual(["d1"]);
  expect(
    ids(
      await zbar
        .list()
        .object(gB)
        .relation("seats")
        .subject("system_user")
        .collect(ctx),
      "subjectId",
    ),
  ).toEqual(["rm"]);
  expect(
    ids(
      await zbar
        .list()
        .object(s1)
        .relation("member")
        .subject("system_user")
        .collect(ctx),
      "subjectId",
    ),
  ).toEqual(["ad", "ow", "rm", "vw"]);

  // The hot materialized relation is one range; the cold computed one expands at read time.
  expect(
    ids(
      await zbar
        .list()
        .object("notification_rule")
        .relation("source")
        .subject(d1)
        .collect(ctx),
      "objectId",
    ),
  ).toEqual(["rule1"]);
  expect(
    ids(
      await zbar
        .list()
        .object(rule1)
        .relation("recipient")
        .subject("system_user")
        .collect(ctx),
      "subjectId",
    ),
  ).toEqual(["ad", "ow", "rm", "vw"]);
  expect(
    ids(
      await zbar
        .list()
        .object(rule2)
        .relation("recipient")
        .subject("system_user")
        .collect(ctx),
      "subjectId",
    ),
  ).toEqual(["rm"]);

  // Lists of reach.
  expect(
    ids(
      await zbar
        .list()
        .object("device")
        .permission("view")
        .subject(rm)
        .collect(ctx),
      "objectId",
    ),
  ).toEqual(["d1", "d2"]);
  expect(
    ids(
      await zbar
        .list()
        .object("device")
        .permission("view")
        .subject(vw)
        .collect(ctx),
      "objectId",
    ),
  ).toEqual(["d1", "d2", "d3"]);
  expect(
    ids(
      await zbar
        .list()
        .object(d1)
        .permission("operate")
        .subject("system_user")
        .collect(ctx),
      "subjectId",
    ),
  ).toEqual(["ad", "ow", "rm", "vw"]);
  expect(
    ids(
      await zbar
        .list()
        .object("device")
        .permission("view")
        .subject(rm)
        .via(s1)
        .collect(ctx),
      "objectId",
    ),
  ).toEqual(["d1", "d2"]);

  // listDirect: facts with properties; an inverse set lists its facts flipped.
  const recipients = await zbar
    .listDirect()
    .object(rule2)
    .relation("recipient")
    .collect(ctx);
  expect(
    recipients
      .map((r: any) => [
        `${r.subject.type}:${r.subject.id}`,
        r.properties ?? null,
      ])
      .sort(),
  ).toEqual([
    ["linked_recipient:lr1", null],
    ["system_user:rm", { push: true, email: false }],
  ]);
  const members = await zbar
    .listDirect()
    .object(s1)
    .relation("devices")
    .collect(ctx);
  expect(
    members
      .map((r: any) => `${r.subject.id} ${r.relation} ${r.object.id}`)
      .sort(),
  ).toEqual(["d1 devices s1", "d2 devices s1", "d3 devices s1"]);
});
