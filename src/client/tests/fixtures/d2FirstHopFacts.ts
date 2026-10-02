/**
 * D2 — the first hop reads facts (CONTRACT §2.1, §4.2).
 *
 * `group.member: ['user', 'group']` with NO `group#member`, and
 * `doc.reader: ['group', 'group#member']`. g2 is a member of g1, g1 reads
 * doc. The reader set is {g1} ∪ g1.member = {g1, g2, u1}. u2 (a member of g2,
 * two levels down) must NOT read: g2 reached `reader` as a derived row, and a
 * derived row is never a first hop. The old BFS re-fired on its own output.
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
const g1 = node("group", "g1");
const g2 = node("group", "g2");
const g3 = node("group", "g3");
const doc = node("doc", "doc1");

export const d2FirstHopFacts: Fixture = {
  name: "d2FirstHopFacts",
  schema: [
    entity("user"),
    entity("group", [rel("member", "user", "group")]),
    entity("doc", [
      rel("reader", "group", "group#member"),
      perm("read", "reader"),
    ]),
  ],
  nodes: [u1, u2, g1, g2, g3, doc],
  steps: eachOpAStep([
    add(g1, "reader", doc),
    add(g2, "member", g1), //   g2 ∈ g1.member → g2 reads (a derived row)
    add(u1, "member", g1), //   u1 reads
    add(u2, "member", g2), //   u2 must NOT read: g2 is not a first-hop fact of reader
    add(g3, "member", g2),
    remove(u1, "member", g1),
    set(g2, "reader", doc), //  now g2 IS a fact at reader → u2 and g3 read
    deleteEntity(g1),
  ]),
};
