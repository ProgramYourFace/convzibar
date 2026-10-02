/**
 * Fixture description language for the parity test (`../parity.test.ts`).
 *
 * A fixture is written ONCE as plain data: entities, each a list of sets
 * (relations and permissions) whose arms are the five string forms of
 * CONTRACT.md §2. `derive.ts` turns one description into the two schemas the
 * test compares ("every walks/expands arm computed" and "every eligible
 * walks/expands arm materialized"); `oracle.ts` evaluates the same
 * description over facts, literally, as the contract states it.
 */
import type { PropertyValidators } from "convex/values";

/**
 * One arm, in the builder's string grammar: facts `'system_user'`, inherits
 * `'admin'`, expands `'group#viewer'`, walks `'parent.admin'`, inverse
 * `'~device#parent'`. The object form pins a walks/expands arm to computed in
 * BOTH variants (the per-arm flag); every other walks/expands arm on a
 * relation is materialized in the materialized variant when that is legal.
 */
export type ArmDesc = string | { arm: string; keepComputed: true };

export interface SetDesc {
  name: string;
  kind: "relation" | "permission";
  arms: ArmDesc[];
}

export interface EntityDesc {
  name: string;
  sets: SetDesc[];
  properties?: Record<string, PropertyValidators>;
}

export type SchemaDesc = EntityDesc[];

export interface Node {
  type: string;
  id: string;
}

export type Op =
  | {
      op: "add";
      subject: Node;
      relation: string;
      object: Node;
      properties?: Record<string, unknown>;
    }
  | { op: "remove"; subject: Node; relation: string; object: Node }
  | { op: "set"; subject: Node; relation: string; object: Node }
  | { op: "deleteEntity"; entity: Node };

/** A named batch of writes; every read is compared after each step. */
export interface Step {
  name: string;
  ops: Op[];
}

export interface Fixture {
  name: string;
  schema: SchemaDesc;
  /** Every node the reads range over (subjects and objects of the cross-product). */
  nodes: Node[];
  /** Entities passed to `.via()` on every list. */
  via?: Node[];
  steps: Step[];
  /** Client `maxDepth` (default 16). */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Small constructors so fixtures read like the schema they describe.
// ---------------------------------------------------------------------------

export const entity = (
  name: string,
  sets: SetDesc[] = [],
  properties?: Record<string, PropertyValidators>,
): EntityDesc => ({ name, sets, properties });

export const rel = (name: string, ...arms: ArmDesc[]): SetDesc => ({
  name,
  kind: "relation",
  arms,
});
export const perm = (name: string, ...arms: ArmDesc[]): SetDesc => ({
  name,
  kind: "permission",
  arms,
});
export const computedOnly = (arm: string): ArmDesc => ({
  arm,
  keepComputed: true,
});

export const node = (type: string, id: string): Node => ({ type, id });

export const add = (
  subject: Node,
  relation: string,
  object: Node,
  properties?: Record<string, unknown>,
): Op => ({ op: "add", subject, relation, object, properties });
export const remove = (subject: Node, relation: string, object: Node): Op => ({
  op: "remove",
  subject,
  relation,
  object,
});
export const set = (subject: Node, relation: string, object: Node): Op => ({
  op: "set",
  subject,
  relation,
  object,
});
export const deleteEntity = (entity: Node): Op => ({
  op: "deleteEntity",
  entity,
});

/** One op per step, named after the op: the finest-grained comparison. */
export const eachOpAStep = (ops: Op[]): Step[] =>
  ops.map((op) => ({ name: describeOp(op), ops: [op] }));

export const nodeKey = (n: Node) => `${n.type}:${n.id}`;

export function describeOp(op: Op): string {
  switch (op.op) {
    case "add":
      return `add (${nodeKey(op.subject)}, ${op.relation}, ${nodeKey(op.object)})${
        op.properties ? " " + JSON.stringify(op.properties) : ""
      }`;
    case "remove":
      return `remove (${nodeKey(op.subject)}, ${op.relation}, ${nodeKey(op.object)})`;
    case "set":
      return `setRelation (${nodeKey(op.subject)}, ${op.relation}, ${nodeKey(op.object)})`;
    case "deleteEntity":
      return `deleteEntity ${nodeKey(op.entity)}`;
  }
}
