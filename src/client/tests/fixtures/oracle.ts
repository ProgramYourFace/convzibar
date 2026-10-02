/**
 * An independent evaluator of CONTRACT.md §2, written from the contract text
 * and nothing else, so the parity test is anchored to the contract and not
 * only to itself. It knows nothing about materialization: it is the meaning
 * both engines must reproduce.
 *
 * members(o, S) for a set S on o's type is the union of:
 *
 *   - every fact (x, S, o)                                  (S a relation: written facts, any arm type)
 *   - facts  'T'      — covered by the line above
 *   - inherits 'X'    — members(o, X)
 *   - expands 'T#t'   — members(m, t) for each fact (m:T, r, o), r ∈ factRelations[o.type][S]
 *   - walks  'v.t'    — members(m, t) for each fact (m:V, r, o), r ∈ factRelations[o.type][v],
 *                       V a declared via type that has t
 *   - inverse '~T#r'  — { x:T | fact (o, r, x) }
 *
 * First hops read FACTS only (§2.1); second hops read the FULL set (§2.2).
 * Recursion is the least fixed point: every (node, set) starts empty and the
 * equations are re-applied until nothing grows (all arms are monotone).
 */
import { SchemaIndex } from "./derive";
import { nodeKey, type Node, type Op, type SchemaDesc } from "./types";

export interface Fact {
  subject: Node;
  relation: string;
  object: Node;
  properties?: Record<string, unknown>;
}

const factKey = (f: { subject: Node; relation: string; object: Node }) =>
  `${nodeKey(f.subject)} ${f.relation} ${nodeKey(f.object)}`;

/** The fact store as the test believes it to be: the same ops, applied by their documented meaning. */
export class FactLog {
  private facts = new Map<string, Fact>();

  apply(op: Op) {
    switch (op.op) {
      case "add":
        this.facts.set(factKey(op), {
          subject: op.subject,
          relation: op.relation,
          object: op.object,
          properties: op.properties,
        });
        return;
      case "remove":
        this.facts.delete(factKey(op));
        return;
      case "set":
        // setRelation replaces every other relation the subject holds on the object.
        for (const [k, f] of this.facts)
          if (
            nodeKey(f.subject) === nodeKey(op.subject) &&
            nodeKey(f.object) === nodeKey(op.object)
          )
            this.facts.delete(k);
        this.facts.set(factKey(op), {
          subject: op.subject,
          relation: op.relation,
          object: op.object,
        });
        return;
      case "deleteEntity":
        for (const [k, f] of this.facts)
          if (
            nodeKey(f.subject) === nodeKey(op.entity) ||
            nodeKey(f.object) === nodeKey(op.entity)
          )
            this.facts.delete(k);
        return;
    }
  }

  has(f: { subject: Node; relation: string; object: Node }) {
    return this.facts.has(factKey(f));
  }

  all(): Fact[] {
    return [...this.facts.values()];
  }
}

export class Oracle {
  private readonly ix: SchemaIndex;
  /** members[`${nodeKey(o)}|${set}`] = node keys of the subjects in the set. */
  private readonly members = new Map<string, Set<string>>();
  private readonly nodes = new Map<string, Node>();

  constructor(
    desc: SchemaDesc,
    private readonly facts: Fact[],
    universe: Node[],
  ) {
    this.ix = new SchemaIndex(desc);
    for (const n of universe) this.nodes.set(nodeKey(n), n);
    for (const f of facts) {
      this.nodes.set(nodeKey(f.subject), f.subject);
      this.nodes.set(nodeKey(f.object), f.object);
    }
    this.solve();
  }

  private factsInto(object: Node, relation: string) {
    const k = nodeKey(object);
    return this.facts.filter(
      (f) => f.relation === relation && nodeKey(f.object) === k,
    );
  }

  private get(o: Node, set: string) {
    return this.members.get(`${nodeKey(o)}|${set}`) ?? new Set<string>();
  }

  /** One application of the §2 equations for (o, S), reading the current approximation. */
  private evaluate(o: Node, set: string): Set<string> {
    const ix = this.ix;
    const out = new Set<string>();
    if (ix.set(o.type, set)?.kind === "relation")
      for (const f of this.factsInto(o, set)) out.add(nodeKey(f.subject));
    for (const arm of ix.arms(o.type, set)) {
      switch (arm.kind) {
        case "facts":
          break; // the facts of this set are added above
        case "inherits":
          for (const m of this.get(o, arm.set)) out.add(m);
          break;
        case "expands":
          for (const r of ix.factRelations(o.type, set))
            for (const f of this.factsInto(o, r))
              if (f.subject.type === arm.subjectType)
                for (const m of this.get(f.subject, arm.targetSet)) out.add(m);
          break;
        case "walks": {
          const viaTypes = new Set(
            ix.walkViaTypes(o.type, arm.viaRelation, arm.targetSet),
          );
          for (const r of ix.factRelations(o.type, arm.viaRelation))
            for (const f of this.factsInto(o, r))
              if (viaTypes.has(f.subject.type))
                for (const m of this.get(f.subject, arm.targetSet)) out.add(m);
          break;
        }
        case "inverse":
          for (const f of this.facts)
            if (
              f.relation === arm.relation &&
              nodeKey(f.subject) === nodeKey(o) &&
              f.object.type === arm.subjectType
            )
              out.add(nodeKey(f.object));
          break;
      }
    }
    return out;
  }

  private solve() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const o of this.nodes.values())
        for (const s of this.ix.sets(o.type)) {
          const next = this.evaluate(o, s.name);
          const key = `${nodeKey(o)}|${s.name}`;
          if (next.size !== (this.members.get(key)?.size ?? 0)) {
            this.members.set(key, next);
            changed = true;
          }
        }
    }
  }

  /** `can` / `hasRelationship`: is the subject in the set on the object. */
  check(subject: Node, set: string, object: Node): boolean {
    return this.get(object, set).has(nodeKey(subject));
  }

  /** `getPermissions`, sorted. */
  permissions(subject: Node, object: Node): string[] {
    return this.ix
      .permissions(object.type)
      .map((p) => p.name)
      .filter((p) => this.check(subject, p, object))
      .sort();
  }

  /** `list().object(type).set(x).subject(s)` — object ids, sorted. */
  listObjects(objectType: string, set: string, subject: Node): string[] {
    const ids: string[] = [];
    for (const n of this.nodes.values())
      if (n.type === objectType && this.check(subject, set, n)) ids.push(n.id);
    return [...new Set(ids)].sort();
  }

  /** `list().object(o).set(x).subject(type)` — subject ids, sorted. */
  listSubjects(object: Node, set: string, subjectType: string): string[] {
    const ids: string[] = [];
    for (const k of this.get(object, set)) {
      const n = this.nodes.get(k)!;
      if (n.type === subjectType) ids.push(n.id);
    }
    return [...new Set(ids)].sort();
  }
}
