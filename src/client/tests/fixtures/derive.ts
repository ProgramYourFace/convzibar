/**
 * One fixture description → the two schemas the parity test compares.
 *
 *   computed      every arm exactly as written (all walks/expands computed).
 *   materialized  every walks/expands arm that may legally be materialized is
 *                 wrapped in `materialize()`.
 *
 * "Legally" is CONTRACT.md §4.6 plus §2: only an arm on a RELATION can be
 * materialized (nothing is written to a permission), and a materialized arm's
 * second hop (the inherits closure of its target set on the intermediate
 * type) may not contain a computed walks/expands arm. The eligible set is the
 * greatest fixed point: start from every candidate and drop any arm whose
 * second hop still sees a computed walks/expands arm, until nothing changes.
 * For schemas whose walks/expands arms all sit on relations that is every
 * arm, recursive sets included; arms on permissions (and anything whose
 * second hop goes through one) stay computed on both sides.
 */
import { createZbarSchema, materialize } from "../../index";
import type { ArmDesc, SchemaDesc } from "./types";

export type ParsedArm =
  | { kind: "facts"; subjectType: string }
  | { kind: "inherits"; set: string }
  | { kind: "expands"; subjectType: string; targetSet: string }
  | { kind: "walks"; viaRelation: string; targetSet: string }
  | { kind: "inverse"; subjectType: string; relation: string };

export const armString = (a: ArmDesc) => (typeof a === "string" ? a : a.arm);

export function parseArm(arm: string, entityNames: Set<string>): ParsedArm {
  if (arm.startsWith("~")) {
    const [subjectType, relation] = arm.slice(1).split("#");
    return { kind: "inverse", subjectType, relation };
  }
  if (arm.includes("#")) {
    const [subjectType, targetSet] = arm.split("#");
    return { kind: "expands", subjectType, targetSet };
  }
  if (arm.includes(".")) {
    const [viaRelation, targetSet] = arm.split(".");
    return { kind: "walks", viaRelation, targetSet };
  }
  return entityNames.has(arm)
    ? { kind: "facts", subjectType: arm }
    : { kind: "inherits", set: arm };
}

/** Lookups over a description, shared by the derivation, the oracle and the random generator. */
export class SchemaIndex {
  readonly entityNames: Set<string>;
  constructor(readonly desc: SchemaDesc) {
    this.entityNames = new Set(desc.map((e) => e.name));
  }

  sets(type: string) {
    return this.desc.find((e) => e.name === type)?.sets ?? [];
  }
  set(type: string, name: string) {
    return this.sets(type).find((s) => s.name === name);
  }
  relations(type: string) {
    return this.sets(type).filter((s) => s.kind === "relation");
  }
  permissions(type: string) {
    return this.sets(type).filter((s) => s.kind === "permission");
  }
  arms(type: string, name: string): ParsedArm[] {
    return (this.set(type, name)?.arms ?? []).map((a) =>
      parseArm(armString(a), this.entityNames),
    );
  }

  /** `inherits[type][name]`: the set plus every set it transitively inherits (CONTRACT §2.4). */
  inheritsClosure(type: string, name: string): string[] {
    const out: string[] = [];
    const visit = (n: string) => {
      if (out.includes(n) || !this.set(type, n)) return;
      out.push(n);
      for (const a of this.arms(type, n))
        if (a.kind === "inherits") visit(a.set);
    };
    visit(name);
    return out;
  }

  /** `factRelations[type][name]`: the writable members of the inherits closure (CONTRACT §2.1). */
  factRelations(type: string, name: string): string[] {
    return this.inheritsClosure(type, name).filter(
      (n) => this.set(type, n)?.kind === "relation",
    );
  }

  /** Subject types a fact of relation `(type, name)` may carry: facts arms plus expands arms (S2). */
  writableTypes(type: string, name: string): string[] {
    const out = new Set<string>();
    for (const a of this.arms(type, name)) {
      if (a.kind === "facts") out.add(a.subjectType);
      if (a.kind === "expands") out.add(a.subjectType);
    }
    return [...out];
  }

  /**
   * The declared via types of a walks arm on `type`: the types writable on the
   * via relation and on every relation it inherits, restricted to types that
   * have the target set (one compiled arm per such type).
   */
  walkViaTypes(type: string, viaRelation: string, targetSet: string): string[] {
    const out = new Set<string>();
    for (const r of this.factRelations(type, viaRelation))
      for (const t of this.writableTypes(type, r))
        if (this.set(t, targetSet)) out.add(t);
    return [...out];
  }

  /** The (intermediateType, targetSet) pairs a walks/expands arm's second hop reads. */
  secondHops(type: string, arm: ParsedArm): { type: string; set: string }[] {
    if (arm.kind === "expands")
      return [{ type: arm.subjectType, set: arm.targetSet }];
    if (arm.kind === "walks")
      return this.walkViaTypes(type, arm.viaRelation, arm.targetSet).map(
        (t) => ({
          type: t,
          set: arm.targetSet,
        }),
      );
    return [];
  }
}

const armId = (type: string, set: string, index: number) =>
  `${type}.${set}[${index}]`;

/** The ids (`type.set[armIndex]`) of every arm the materialized variant wraps in `materialize()`. */
export function eligibleMaterializedArms(desc: SchemaDesc): Set<string> {
  const ix = new SchemaIndex(desc);
  const materialized = new Set<string>();
  const where = new Map<string, { type: string; set: string; index: number }>();
  for (const e of desc)
    for (const s of e.sets) {
      if (s.kind !== "relation") continue;
      s.arms.forEach((a, i) => {
        if (typeof a !== "string") return; // keepComputed
        const p = parseArm(a, ix.entityNames);
        if (p.kind !== "walks" && p.kind !== "expands") return;
        const id = armId(e.name, s.name, i);
        materialized.add(id);
        where.set(id, { type: e.name, set: s.name, index: i });
      });
    }

  // Greatest fixed point: drop arms whose second hop contains a computed walks/expands arm.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...materialized]) {
      const { type, set, index } = where.get(id)!;
      const arm = ix.arms(type, set)[index];
      const ok = ix
        .secondHops(type, arm)
        .every(({ type: t, set: target }) =>
          ix
            .inheritsClosure(t, target)
            .every((member) =>
              ix
                .arms(t, member)
                .every(
                  (inner, j) =>
                    (inner.kind !== "walks" && inner.kind !== "expands") ||
                    materialized.has(armId(t, member, j)),
                ),
            ),
        );
      if (!ok) {
        materialized.delete(id);
        changed = true;
      }
    }
  }
  return materialized;
}

/** Build a schema from a description, wrapping the arms in `materializedArms`. */
function buildSchema(desc: SchemaDesc, materializedArms: Set<string>) {
  let b: any = createZbarSchema();
  for (const e of desc) {
    if (e.sets.length === 0 && !e.properties) {
      b = b.entity(e.name);
      continue;
    }
    b = b.entity(e.name, (eb: any) => {
      let x = eb;
      for (const s of e.sets) {
        const arms = s.arms.map((a, i) =>
          materializedArms.has(armId(e.name, s.name, i))
            ? materialize(armString(a) as any)
            : armString(a),
        );
        x =
          s.kind === "relation"
            ? x.relation(s.name, ...arms)
            : x.permission(s.name, ...arms);
      }
      for (const [relation, validators] of Object.entries(e.properties ?? {}))
        x = x.properties(relation, validators);
      return x;
    });
  }
  return b.build();
}

export function deriveSchemas(desc: SchemaDesc) {
  const materializedArms = eligibleMaterializedArms(desc);
  return {
    computed: buildSchema(desc, new Set()),
    materialized: buildSchema(desc, materializedArms),
    materializedArms: [...materializedArms].sort(),
  };
}
