/**
 * The app schema (schemas/zbar.ts) as a fixture description, with a small,
 * realistic universe. `schemaCompiler.test.ts` checks that this description
 * compiles to exactly the real schema's sets (materialize flags aside), so it
 * cannot drift.
 *
 *   s1 ─┬─ gA (vw is its admin)          d1: gA at admin, gB at operator
 *       ├─ gB (rm is its member)         d2: a direct seat grant (rm viewer)
 *       ├─ d1, d2, d3                    d3: only through the parent
 *       ├─ gf1 (gB views), db1 (gA views)
 *       ├─ rule1: source gA, recipient the system (system#member)
 *       └─ rule2: source d2, recipient rm (with channel properties) + a linked recipient
 *
 *   seats: ow (owner), ad (admin), vw (system viewer, admin of gA), rm (restricted member)
 *
 * In the materialized variant every walks/expands arm on a relation is
 * materialized (the app itself materializes only `rule.source`'s two); the
 * permission walks (`group.view ⊇ parent.viewer`, …) stay computed.
 */
import { v } from "convex/values";
import {
  add,
  deleteEntity,
  entity,
  node,
  perm,
  rel,
  remove,
  set,
  type Fixture,
  type SchemaDesc,
  type Step,
} from "./types";

export const appSchemaDesc: SchemaDesc = [
  entity("linked_recipient"),
  entity("system", [
    rel("owner", "system_user"),
    rel("admin", "owner", "system_user"),
    rel("viewer", "admin", "system_user"),
    rel("member", "~system_user#parent"),
    rel("devices", "~device#parent"),
    perm("view", "viewer"),
    perm("view_as_member", "member"),
    perm("manage_resources", "admin"),
    perm("manage_members", "admin"),
    perm("manage_owners", "owner"),
    perm("manage", "owner"),
    perm("configure_as_recipient", "admin"),
  ]),
  entity("group", [
    rel("parent", "system"),
    rel("admin", "system_user"),
    rel("viewer", "admin", "system_user"),
    rel("devices", "~device#admin", "~device#operator", "~device#viewer"),
    rel("seats", "~system_user#admin", "~system_user#viewer"),
    perm("view", "viewer", "parent.viewer"),
    perm("manage", "admin", "parent.admin"),
    perm("manage_members", "admin", "parent.admin"),
    perm("configure_as_recipient", "admin", "parent.admin"),
  ]),
  entity("device", [
    rel("parent", "system"),
    rel("admin", "system_user", "group#admin", "parent.admin"),
    rel("operator", "admin", "system_user", "group#viewer"),
    rel("viewer", "operator", "system_user", "group#viewer", "parent.viewer"),
    perm("view", "viewer"),
    perm("operate", "operator"),
    perm("manage", "admin"),
  ]),
  entity("geofence", [
    rel("parent", "system"),
    rel("admin", "system_user", "group#admin", "parent.admin"),
    rel("viewer", "admin", "system_user", "group#viewer", "parent.viewer"),
    perm("view", "viewer"),
    perm("manage", "admin"),
  ]),
  entity("system_user", [
    rel("parent", "system"),
    rel("self", "system_user"),
    rel("admin", "system_user", "group#admin", "parent.admin"),
    rel(
      "viewer",
      "admin",
      "self",
      "system_user",
      "group#viewer",
      "parent.viewer",
    ),
    perm("view", "viewer"),
    perm("manage", "admin"),
    perm("configure_as_recipient", "viewer"),
  ]),
  entity(
    "notification_rule",
    [
      rel("parent", "system"),
      rel("source", "device", "group#devices", "system#devices"),
      rel(
        "recipient",
        "system_user",
        "linked_recipient",
        "group#seats",
        "system#member",
      ),
      rel("admin", "system_user", "group#admin", "parent.admin"),
      rel("viewer", "admin", "system_user", "group#viewer", "parent.viewer"),
      perm("view", "viewer"),
      perm("manage", "admin"),
    ],
    {
      recipient: {
        email: v.optional(v.boolean()),
        sms: v.optional(v.boolean()),
        push: v.optional(v.boolean()),
        fallback: v.optional(v.boolean()),
      },
    },
  ),
  entity("dashboard", [
    rel("parent", "system"),
    rel("viewer", "system_user", "group#viewer", "parent.viewer"),
    perm("view", "viewer"),
    perm("manage", "parent.admin"),
  ]),
];

export const s1 = node("system", "s1");
export const gA = node("group", "gA");
export const gB = node("group", "gB");
export const d1 = node("device", "d1");
export const d2 = node("device", "d2");
export const d3 = node("device", "d3");
export const ow = node("system_user", "ow");
export const ad = node("system_user", "ad");
export const vw = node("system_user", "vw");
export const rm = node("system_user", "rm");
export const rule1 = node("notification_rule", "rule1");
export const rule2 = node("notification_rule", "rule2");
export const gf1 = node("geofence", "gf1");
export const db1 = node("dashboard", "db1");
export const lr1 = node("linked_recipient", "lr1");

export const appNodes = [
  s1,
  gA,
  gB,
  d1,
  d2,
  d3,
  ow,
  ad,
  vw,
  rm,
  rule1,
  rule2,
  gf1,
  db1,
  lr1,
];
const seats = [ow, ad, vw, rm];

const steps: Step[] = [
  {
    name: "structure: every resource parented to s1, seats carry parent + self",
    ops: [
      ...[gA, gB, d1, d2, d3, rule1, rule2, gf1, db1].map((n) =>
        add(s1, "parent", n),
      ),
      ...seats.map((s) => add(s1, "parent", s)),
      ...seats.map((s) => add(s, "self", s)),
    ],
  },
  {
    name: "system roles",
    ops: [add(ow, "owner", s1), add(ad, "admin", s1), add(vw, "viewer", s1)],
  },
  {
    name: "groups and their tiers on resources",
    ops: [
      add(vw, "admin", gA),
      add(rm, "viewer", gB),
      add(gA, "admin", d1), //   d1 in both groups at different tiers
      add(gB, "operator", d1),
      add(rm, "viewer", d2), //  d2: a direct seat grant
      add(gB, "viewer", gf1),
      add(gA, "viewer", db1),
      add(gB, "viewer", vw), //  gB's members see vw's profile
    ],
  },
  {
    name: "rules: a group source with a system recipient, a device source with seat recipients",
    ops: [
      add(gA, "source", rule1),
      add(s1, "recipient", rule1),
      add(d2, "source", rule2),
      add(rm, "recipient", rule2, { push: true, email: false }),
      add(lr1, "recipient", rule2, { sms: true }),
      add(gB, "recipient", rule2),
    ],
  },
  { name: "remove gB from d1", ops: [remove(gB, "operator", d1)] },
  { name: "remove vw as admin of gA", ops: [remove(vw, "admin", gA)] },
  {
    name: "remove a seat parent fact (system.member shrinks)",
    ops: [remove(s1, "parent", ad)],
  },
  {
    name: "setRelation: rm from member to admin of gB",
    ops: [set(rm, "admin", gB)],
  },
  { name: "deleteEntity gA", ops: [deleteEntity(gA)] },
];

export const appSchema: Fixture = {
  name: "appSchema",
  schema: appSchemaDesc,
  nodes: appNodes,
  via: [s1],
  steps,
};
