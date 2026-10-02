/**
 * D5 — bounds depend on the schema and the facts, never on write order
 * (CONTRACT §4.7, §4.8).
 *
 * `acyclicChain(order)`: six distinct entity types, each `viewer ⊇
 * parent.viewer` — a 6-long acyclic walks chain under the default maxDepth.
 * Written top-down and bottom-up, both orders must give the same answers.
 *
 * `recursiveChain`: one recursive type, `folder.viewer ⊇ parent.viewer`, a
 * chain of 7 folders, `maxDepth: 4`. Past the bound a computed read THROWS
 * and the materialized write records an `expansionFailures` row with
 * `reason: 'depth'`; nothing is silently truncated.
 */
import {
  add,
  eachOpAStep,
  entity,
  node,
  perm,
  rel,
  remove,
  type Fixture,
  type Op,
} from "./types";

const LEVELS = ["l1", "l2", "l3", "l4", "l5", "l6"];
const u = node("user", "u");
const other = node("user", "other");
const top = node("root", "r");
const chain = LEVELS.map((t) => node(t, `${t}_a`));

const chainSchema = [
  entity("user"),
  entity("root", [rel("viewer", "user"), perm("view", "viewer")]),
  ...LEVELS.map((t, i) =>
    entity(t, [
      rel("parent", i === 0 ? "root" : LEVELS[i - 1]),
      rel("viewer", "user", "parent.viewer"),
      perm("view", "viewer"),
    ]),
  ),
];

/** (root → l1 → … → l6) parent facts, plus the grant at the top. */
const chainFacts: Op[] = [
  add(u, "viewer", top),
  add(top, "parent", chain[0]),
  ...chain.slice(1).map((n, i) => add(chain[i], "parent", n)),
  add(other, "viewer", chain[2]), // a grant in the middle of the chain
];

export function acyclicChain(order: "top-down" | "bottom-up"): Fixture {
  const ops = order === "top-down" ? chainFacts : [...chainFacts].reverse();
  return {
    name: `d5Depth acyclic (${order})`,
    schema: chainSchema,
    nodes: [u, other, top, ...chain],
    steps: [
      ...eachOpAStep(ops),
      // Cut the chain in the middle; the tail loses u, keeps other below l3.
      ...eachOpAStep([remove(chain[3], "parent", chain[4])]),
    ],
  };
}

const FOLDERS = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"].map((id) =>
  node("folder", id),
);
export const recursiveSeat = u;
/** f1 is the top: `(f_i, parent, f_{i+1})`. f2 is 1 walk from f1; f7 is 6. */
export const recursiveFolders = FOLDERS;

export const recursiveChain: Fixture = {
  name: "d5Depth recursive past maxDepth",
  maxDepth: 4,
  schema: [
    entity("user"),
    entity("folder", [
      rel("parent", "folder"),
      rel("viewer", "user", "parent.viewer"),
      perm("view", "viewer"),
    ]),
  ],
  nodes: [u, ...FOLDERS],
  steps: eachOpAStep([
    add(u, "viewer", FOLDERS[0]),
    ...FOLDERS.slice(1).map((f, i) => add(FOLDERS[i], "parent", f)),
  ]),
};
