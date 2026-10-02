/**
 * D1 — typed intermediate (proposal §4.1, CONTRACT §4.1).
 *
 * `device.operator ⊇ group#viewer`. A SEAT is written to `operator`, and a
 * second seat views the first seat's profile (`system_user.viewer`). An arm
 * derives only through intermediates of the type it names: the seat is not a
 * group, so the second seat must NOT operate. The old write-time rule matched
 * the intermediate by relation name and over-granted here.
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

const ana = node("system_user", "ana");
const bo = node("system_user", "bo");
const cy = node("system_user", "cy");
const g1 = node("group", "g1");
const d1 = node("device", "d1");

export const d1TypedIntermediate: Fixture = {
  name: "d1TypedIntermediate",
  schema: [
    entity("system_user", [
      rel("viewer", "system_user"),
      perm("view", "viewer"),
    ]),
    entity("group", [rel("viewer", "system_user")]),
    entity("device", [
      rel("operator", "system_user", "group#viewer"),
      perm("operate", "operator"),
    ]),
  ],
  nodes: [ana, bo, cy, g1, d1],
  steps: eachOpAStep([
    add(ana, "operator", d1), //       a seat at the expands' relation
    add(bo, "viewer", ana), //         bo views ana's profile — bo must NOT operate d1
    add(g1, "operator", d1), //        the typed path: a group at operator
    add(cy, "viewer", g1), //          cy operates d1 through g1
    remove(ana, "operator", d1),
    set(bo, "viewer", g1), //          bo now really is a member of g1 → operates
    deleteEntity(g1), //               and loses it with the group
  ]),
};
