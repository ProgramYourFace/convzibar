/**
 * D6 — the dominated-rule prune counter-example (CONTRACT §2.1, S6).
 *
 * `doc.editor: ['team', 'parent.viewer']`,
 * `doc.reader: ['team', 'editor', 'parent.viewer', 'team#member']`.
 * `reader ⊇ editor` made the old compiler drop reader's own rules as
 * "dominated", but the first hop of `team#member` on reader must read the
 * facts of reader AND editor: a team written only at `editor` has members
 * that read. And reader's walk second hop is folder.viewer, which itself has
 * an expands arm (materialized on the materialized side).
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

const u1 = node("user", "u1");
const u2 = node("user", "u2");
const u3 = node("user", "u3");
const u4 = node("user", "u4");
const t1 = node("team", "t1");
const t2 = node("team", "t2");
const t3 = node("team", "t3");
const f1 = node("folder", "f1");
const doc = node("doc", "doc1");

export const d6Inherits: Fixture = {
  name: "d6Inherits",
  schema: [
    entity("user"),
    entity("team", [rel("member", "user")]),
    entity("folder", [rel("viewer", "user", "team#member")]),
    entity("doc", [
      rel("parent", "folder"),
      rel("editor", "team", "parent.viewer"),
      rel("reader", "team", "editor", "parent.viewer", "team#member"),
      perm("edit", "editor"),
      perm("read", "reader"),
    ]),
  ],
  nodes: [u1, u2, u3, u4, t1, t2, t3, f1, doc],
  steps: eachOpAStep([
    add(t1, "editor", doc), //  t1 only at editor: its members READ (first hop reads editor facts)
    add(u1, "member", t1),
    add(t2, "reader", doc),
    add(u2, "member", t2), //   reads, does not edit
    add(f1, "parent", doc),
    add(u3, "viewer", f1), //   edits and reads through the folder
    add(t3, "viewer", f1),
    add(u4, "member", t3), //   folder viewer through a team → edits and reads
    remove(u1, "member", t1),
    set(t1, "reader", doc), //  t1 drops from editor to reader
    deleteEntity(t3),
  ]),
};
