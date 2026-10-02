/**
 * Folder tree — recursion is ordinary (proposal §2.1, CONTRACT §4.8).
 *
 * `group.parent: 'system' | 'group'`; `manage ⊇ admin, parent.manage` (a
 * permission walking a permission: computed on BOTH sides, since nothing is
 * written to a permission) and `viewer ⊇ admin, parent.viewer` (a relation:
 * materialized on the materialized side, recursively). `children` lists a
 * folder's sub-folders through `~group#parent`. Four nested levels plus a
 * sibling branch; a removal cuts the tree in the middle.
 *
 *   sys ─ g1 ─ g2 ─ g3 ─ g4
 *          └─ g5 ─ g6
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
const [g1, g2, g3, g4, g5, g6] = ["g1", "g2", "g3", "g4", "g5", "g6"].map(
  (id) => node("group", id),
);
const owner = node("system_user", "owner"); // system admin
const a2 = node("system_user", "a2"); //       admin of g2
const v1 = node("system_user", "v1"); //       viewer of g1
const a5 = node("system_user", "a5"); //       admin of g5

export const folderTree: Fixture = {
  name: "folderTree",
  schema: [
    entity("system_user"),
    entity("system", [
      rel("admin", "system_user"),
      rel("viewer", "admin", "system_user"),
      perm("manage", "admin"),
    ]),
    entity("group", [
      rel("parent", "system", "group"),
      rel("admin", "system_user"),
      rel("viewer", "admin", "system_user", "parent.viewer"),
      rel("children", "~group#parent"),
      perm("manage", "admin", "parent.manage"),
      perm("view", "viewer"),
    ]),
  ],
  nodes: [sys, g1, g2, g3, g4, g5, g6, owner, a2, v1, a5],
  steps: eachOpAStep([
    add(sys, "parent", g1),
    add(g1, "parent", g2),
    add(g2, "parent", g3),
    add(g3, "parent", g4),
    add(g1, "parent", g5),
    add(g5, "parent", g6),
    add(owner, "admin", sys), // manages and views everything
    add(a2, "admin", g2), //     g2..g4
    add(v1, "viewer", g1), //    views every folder under g1, manages none
    add(a5, "admin", g5), //     g5, g6
    remove(g2, "parent", g3), // cut: g3, g4 leave the tree (a2, owner, v1 lose them)
    set(a5, "viewer", g5), //    a5 drops from admin to viewer
    deleteEntity(g5), //         the sibling branch's root
  ]),
};
