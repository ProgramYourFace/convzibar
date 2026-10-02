/**
 * S6 — the tier ladder from one fact (proposal §3, CONTRACT §2.1).
 *
 * `device.operator: ['admin', 'seat', 'group#viewer']`,
 * `device.viewer: ['operator', 'seat', 'group#viewer', 'parent.viewer']`.
 * A group written ONLY at `admin` on a device: operator's `group#viewer`
 * first hop reads operator AND admin facts, so the group's plain member
 * operates and views. A group written only at `viewer` must not operate.
 */
import {
  add,
  eachOpAStep,
  entity,
  node,
  perm,
  rel,
  remove,
  set,
  deleteEntity,
  type Fixture,
} from "./types";

const sys = node("system", "sys");
const gAdmin = node("group", "g_admin");
const gView = node("group", "g_view");
const d1 = node("device", "d1");
const boss = node("seat", "boss"); //  admin of g_admin
const m1 = node("seat", "m1"); //      plain member of g_admin
const m2 = node("seat", "m2"); //      plain member of g_view
const sv = node("seat", "sv"); //      system viewer

export const s6Ladder: Fixture = {
  name: "s6Ladder",
  schema: [
    entity("seat"),
    entity("system", [rel("viewer", "seat")]),
    entity("group", [rel("admin", "seat"), rel("viewer", "admin", "seat")]),
    entity("device", [
      rel("parent", "system"),
      rel("admin", "seat", "group#admin"),
      rel("operator", "admin", "seat", "group#viewer"),
      rel("viewer", "operator", "seat", "group#viewer", "parent.viewer"),
      perm("manage", "admin"),
      perm("operate", "operator"),
      perm("view", "viewer"),
    ]),
  ],
  nodes: [sys, gAdmin, gView, d1, boss, m1, m2, sv],
  steps: eachOpAStep([
    add(gAdmin, "admin", d1), //  the ONLY containment fact for g_admin
    add(boss, "admin", gAdmin), // manages, operates, views
    add(m1, "viewer", gAdmin), //  operates and views, does not manage
    add(gView, "viewer", d1),
    add(m2, "viewer", gView), //   views, must NOT operate
    add(sys, "parent", d1),
    add(sv, "viewer", sys), //     views through the parent only
    remove(boss, "admin", gAdmin),
    set(gView, "operator", d1), // g_view moves up a tier → m2 operates
    deleteEntity(gAdmin),
  ]),
};
