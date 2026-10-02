/**
 * D3 — mixed arms (CONTRACT §4.6).
 *
 * `rule.source ⊇ group#devices` with `group.devices = ~device#viewer`: an
 * expands arm whose second hop is an INVERSE arm (no rows exist for it). The
 * materialized variant must still follow devices joining and leaving the
 * group after the rule exists — the inverse trigger (§5.2).
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

const seat = node("system_user", "s1");
const g1 = node("group", "g1");
const g2 = node("group", "g2");
const d1 = node("device", "d1");
const d2 = node("device", "d2");
const d3 = node("device", "d3");
const d4 = node("device", "d4");
const r1 = node("rule", "r1");

export const d3MixedArms: Fixture = {
  name: "d3MixedArms",
  schema: [
    entity("system_user"),
    entity("group", [
      rel("member", "system_user"),
      rel("devices", "~device#viewer"),
    ]),
    entity("device", [
      rel("viewer", "system_user", "group"),
      perm("view", "viewer"),
    ]),
    entity("rule", [
      rel("source", "device", "group#devices"),
      perm("fires_for", "source"),
    ]),
  ],
  nodes: [seat, g1, g2, d1, d2, d3, d4, r1],
  steps: eachOpAStep([
    add(g1, "viewer", d1), //    d1 in g1 before the rule exists
    add(g1, "source", r1), //    the rule sources g1's devices
    add(g1, "viewer", d2), //    d2 joins after
    add(d4, "source", r1), //    a direct device source
    add(seat, "viewer", d3), //  a seat, not a group: d3 never joins
    add(g2, "viewer", d3),
    remove(g1, "viewer", d1), // d1 leaves
    set(g2, "source", r1), //    g2 had no relation on r1; set adds it → d3 sources
    deleteEntity(d2),
  ]),
};
