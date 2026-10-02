/**
 * D7 — `.via()` uses the same compiled arms (CONTRACT §4.9).
 *
 * Walks (`parent.viewer`), expands (`group#viewer`) and inverse arms
 * (`system.devices`), listed with and without `.via(system)` for two systems.
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

const s1 = node("system", "s1");
const s2 = node("system", "s2");
const ga = node("group", "ga");
const gb = node("group", "gb");
const d1 = node("device", "d1");
const d2 = node("device", "d2");
const d3 = node("device", "d3");
const u1 = node("user", "u1");
const u2 = node("user", "u2");
const u3 = node("user", "u3");

export const d7Via: Fixture = {
  name: "d7Via",
  schema: [
    entity("user"),
    entity("system", [
      rel("viewer", "user"),
      rel("devices", "~device#parent"),
      perm("view", "viewer"),
    ]),
    entity("group", [
      rel("parent", "system"),
      rel("viewer", "user"),
      perm("view", "viewer", "parent.viewer"),
    ]),
    entity("device", [
      rel("parent", "system"),
      rel("viewer", "user", "group#viewer", "parent.viewer"),
      perm("view", "viewer"),
    ]),
  ],
  nodes: [s1, s2, ga, gb, d1, d2, d3, u1, u2, u3],
  via: [s1, s2],
  steps: eachOpAStep([
    add(s1, "parent", d1),
    add(s1, "parent", d2),
    add(s2, "parent", d3),
    add(s1, "parent", ga),
    add(s2, "parent", gb),
    add(u1, "viewer", s1), //  every s1 device through the walk
    add(ga, "viewer", d3), //  a group of s1 holding a device of s2
    add(u2, "viewer", ga), //  u2 views d3 (a cross-system grant)
    add(u3, "viewer", d2), //  a direct grant
    add(gb, "viewer", d1),
    remove(s1, "parent", d2), // d2 leaves s1
    set(u3, "viewer", gb),
    deleteEntity(ga),
  ]),
};
