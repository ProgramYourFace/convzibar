/**
 * The schema compiler: `ZbarSchema` (what the builder stores) → `GraphConfig`
 * v2 (what both evaluators read). CONTRACT.md is the specification; this file
 * resolves names, rejects schemas the evaluators cannot agree on, and
 * precomputes the closures, lineage bounds and materialization rules so
 * neither evaluator re-derives them (a second derivation is a second chance
 * to disagree).
 *
 * Two phases: `compileSets` (every arm classified and resolved, the inherits
 * closures) and `compileRules` (the materialized arms flattened into rules,
 * keyed by their content and their upstream). `boundLineage` then fills
 * `maxLineage` and enforces the static half of CONTRACT §4.7.
 */
import { DEFAULT_MAX_DEPTH, DEFAULT_WRITE_BUDGET } from "./config";
import { iterateRelationTargets } from "../shared/relation-def";
import type {
  CompiledArm,
  CompiledSet,
  GraphConfig,
  InheritsClosure,
  TraversalRule,
} from "./types";

const ERR = "Zbar Schema Error:";

/** Arms before walks are resolved per via type (that needs the inherits closures). */
type PendingArm =
  | Exclude<CompiledArm, { kind: "walks" }>
  | {
      kind: "walks";
      viaRelation: string;
      targetSet: string;
      materialized: boolean;
      raw: string;
    };

const setLabel = (objectType: string, name: string, writable: boolean) =>
  `${writable ? "relation" : "permission"} '${name}' on '${objectType}'`;

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Object with keys in sorted order, so the config's JSON (and hash) is the same in every process. */
function sortedRecord<V>(entries: Iterable<[string, V]>): Record<string, V> {
  return Object.fromEntries([...entries].sort(([a], [b]) => byKey(a, b)));
}

const armKey = (arm: CompiledArm | PendingArm) => JSON.stringify(arm);

/** FNV-1a (32-bit) of a string with the given offset basis, as 8 hex digits. */
export function fnv1a(s: string, seed = 0x811c9dc5): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function parseSchemaToGraphConfig(
  schema: any,
  options: { maxDepth?: number; writeBudget?: number } = {},
): GraphConfig {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const compiled = compileSets(schema);
  const rules = compileRules(compiled);
  boundLineage(compiled.sets, compiled.inherits, maxDepth);
  return {
    version: 2,
    sets: sortedRecord(Object.entries(compiled.sets)),
    inherits: sortedClosure(compiled.inherits),
    factRelations: sortedClosure(compiled.factRelations),
    rules,
    maxDepth,
    writeBudget: options.writeBudget ?? DEFAULT_WRITE_BUDGET,
  };
}

function sortedClosure(c: InheritsClosure): InheritsClosure {
  return sortedRecord(
    Object.entries(c).map(([t, m]) => [t, sortedRecord(Object.entries(m))]),
  );
}

// ===========================================================================
// Phase 1: sets. Every arm classified; names resolved; inherits closures.
// ===========================================================================

interface CompiledSets {
  sets: Record<string, Record<string, CompiledSet>>;
  inherits: InheritsClosure;
  factRelations: InheritsClosure;
  /** The subject types a fact of `(objectType, set)` may have. */
  subjectTypes: (objectType: string, set: string) => string[];
}

function compileSets(schema: any): CompiledSets {
  // Every set of every entity: name → { writable, arms as written }.
  const raw = new Map<
    string,
    Map<string, { writable: boolean; arms: unknown }>
  >();
  for (const [entityType, def] of Object.entries<any>(schema?.entities ?? {})) {
    const sets = new Map<string, { writable: boolean; arms: unknown }>();
    for (const [name, arms] of Object.entries(def?.relations ?? {})) {
      sets.set(name, { writable: true, arms });
    }
    for (const [name, arms] of Object.entries(def?.permissions ?? {})) {
      if (sets.has(name)) {
        throw new Error(
          `${ERR} '${name}' on '${entityType}' is declared as both a relation and a permission. A set has one name.`,
        );
      }
      sets.set(name, { writable: false, arms });
    }
    raw.set(entityType, sets);
  }
  const entityNames = [...raw.keys()];
  const entitySet = new Set(entityNames);
  const setOf = (type: string, name: string) => raw.get(type)?.get(name);

  // 1a. Classify every arm. Everything except walks is final here; walks
  // need the via relation's subject types, which need the inherits closures.
  const pending = new Map<string, Map<string, PendingArm[]>>();
  for (const [objectType, sets] of raw) {
    const compiledSets = new Map<string, PendingArm[]>();
    for (const [name, { writable, arms }] of sets) {
      const label = setLabel(objectType, name, writable);
      // A set inheriting itself would be a no-op, so its own name resolves
      // as an entity type: `.relation('system', 'system')` means facts.
      const localSets = new Set([...sets.keys()].filter((s) => s !== name));
      const out: PendingArm[] = [];
      const push = (arm: PendingArm) => {
        if (!out.some((a) => armKey(a) === armKey(arm))) out.push(arm);
      };
      for (const shape of iterateRelationTargets(arms, {
        localSets,
        entities: entitySet,
      })) {
        if (shape.kind === "invalid") {
          throw new Error(
            `${ERR} ${label} has arm '${shape.raw}': ${shape.reason}.`,
          );
        }
        if (shape.kind === "unknown") {
          throw new Error(
            `${ERR} ${label} references '${shape.raw}', which is neither a relation or permission declared on '${objectType}' nor a known entity type. ` +
              `Use a declared set [${[...localSets].join(", ")}], an entity type [${entityNames.join(", ")}], ` +
              `a walk ('relation.set'), an expansion ('type#relation') or an inverse ('~type#relation').`,
          );
        }
        if (shape.materialized) {
          if (!writable) {
            throw new Error(
              `${ERR} ${label} materializes '${shape.raw}'; nothing is ever written to a permission, so only relations may be materialized.`,
            );
          }
          if (shape.kind !== "walks" && shape.kind !== "expands") {
            throw new Error(
              `${ERR} ${label} has materialize('${shape.raw}'); only walks ('relation.set') and expansions ('type#relation') can be materialized.`,
            );
          }
        }
        switch (shape.kind) {
          case "facts":
            if (!writable) {
              throw new Error(
                `${ERR} ${label} has facts arm '${shape.subjectType}'; permissions are never written. Put the subject type on a relation and inherit that relation.`,
              );
            }
            push({ kind: "facts", subjectType: shape.subjectType });
            break;
          case "inherits":
            push({ kind: "inherits", set: shape.set });
            break;
          case "expands": {
            const target = setOf(shape.subjectType, shape.targetSet);
            if (!entitySet.has(shape.subjectType) || !target) {
              throw new Error(
                `${ERR} ${label} has arm '${shape.raw}', but ` +
                  (entitySet.has(shape.subjectType)
                    ? `'${shape.subjectType}' declares no set '${shape.targetSet}'. Its sets: [${[...raw.get(shape.subjectType)!.keys()].join(", ")}].`
                    : `'${shape.subjectType}' is not an entity. Known entities: [${entityNames.join(", ")}].`),
              );
            }
            if (!target.writable) {
              throw new Error(
                `${ERR} ${label} has arm '${shape.raw}', but '${shape.targetSet}' is a permission on '${shape.subjectType}'; # may target relations only; use a walk or inherit a relation.`,
              );
            }
            // S2: an expansion makes its type a writable fact type of the
            // relation (a permission has no facts; its first hop reads the
            // facts of the relations it inherits).
            if (writable)
              push({ kind: "facts", subjectType: shape.subjectType });
            push({
              kind: "expands",
              subjectType: shape.subjectType,
              targetSet: shape.targetSet,
              materialized: shape.materialized,
            });
            break;
          }
          case "walks":
            push({
              kind: "walks",
              viaRelation: shape.viaRelation,
              targetSet: shape.targetSet,
              materialized: shape.materialized,
              raw: shape.raw,
            });
            break;
          case "inverse":
            push({
              kind: "inverse",
              subjectType: shape.subjectType,
              relation: shape.relation,
            });
            break;
        }
      }
      compiledSets.set(name, out);
    }
    pending.set(objectType, compiledSets);
  }

  // 1b. Inherits closures (CONTRACT §2.4): `set` first, then what it inherits
  // depth-first in declaration order, deduplicated.
  const inherits: InheritsClosure = {};
  const factRelations: InheritsClosure = {};
  for (const [objectType, sets] of pending) {
    inherits[objectType] = {};
    factRelations[objectType] = {};
    for (const name of sets.keys()) {
      const closure: string[] = [];
      const visit = (s: string) => {
        if (closure.includes(s)) return;
        closure.push(s);
        for (const arm of sets.get(s) ?? [])
          if (arm.kind === "inherits") visit(arm.set);
      };
      visit(name);
      inherits[objectType][name] = closure;
      factRelations[objectType][name] = closure.filter(
        (s) => setOf(objectType, s)!.writable,
      );
    }
  }

  // The subject types a fact of `(objectType, set)` may have: the facts arms
  // (declared or implied by an expansion) of every relation in its closure.
  const subjectTypes = (objectType: string, set: string): string[] => {
    const types: string[] = [];
    for (const member of factRelations[objectType]?.[set] ?? []) {
      for (const arm of pending.get(objectType)!.get(member)!) {
        if (arm.kind === "facts" && !types.includes(arm.subjectType))
          types.push(arm.subjectType);
      }
    }
    return types;
  };

  // 1c. Resolve walks per via type; check inverses.
  const sets: Record<string, Record<string, CompiledSet>> = {};
  for (const [objectType, setArms] of pending) {
    const compiled: [string, CompiledSet][] = [];
    for (const [name, arms] of setArms) {
      const writable = setOf(objectType, name)!.writable;
      const label = setLabel(objectType, name, writable);
      const out: CompiledArm[] = [];
      for (const arm of arms) {
        if (arm.kind === "walks") {
          const via = setOf(objectType, arm.viaRelation);
          if (!via || !via.writable) {
            throw new Error(
              `${ERR} ${label} has arm '${arm.raw}', but '${arm.viaRelation}' is not a relation on '${objectType}'. A walk goes through a relation (its facts are the first hop).`,
            );
          }
          const viaTypes = subjectTypes(objectType, arm.viaRelation);
          const matching = viaTypes.filter((t) => setOf(t, arm.targetSet));
          if (matching.length === 0) {
            throw new Error(
              `${ERR} ${label} has arm '${arm.raw}', but no type reachable through '${arm.viaRelation}' [${viaTypes.join(", ")}] declares a set '${arm.targetSet}'.`,
            );
          }
          for (const viaType of matching) {
            out.push({
              kind: "walks",
              viaRelation: arm.viaRelation,
              viaType,
              targetSet: arm.targetSet,
              materialized: arm.materialized,
            });
          }
          continue;
        }
        if (arm.kind === "inverse") {
          const target = setOf(arm.subjectType, arm.relation);
          const written = `~${arm.subjectType}#${arm.relation}`;
          if (!entitySet.has(arm.subjectType) || !target || !target.writable) {
            throw new Error(
              `${ERR} ${label} has arm '${written}', but '${arm.relation}' is not a relation on '${arm.subjectType}'. An inverse reads the facts of a relation.`,
            );
          }
          const accepted = subjectTypes(arm.subjectType, arm.relation);
          if (!accepted.includes(objectType)) {
            throw new Error(
              `${ERR} ${label} has arm '${written}', but '${arm.subjectType}.${arm.relation}' does not accept '${objectType}' as a fact subject; it accepts [${accepted.join(", ")}].`,
            );
          }
        }
        out.push(arm);
      }
      compiled.push([
        name,
        { objectType, name, writable, arms: out, maxLineage: null },
      ]);
    }
    sets[objectType] = sortedRecord(compiled);
  }
  return { sets, inherits, factRelations, subjectTypes };
}

// ===========================================================================
// Phase 2: rules (CONTRACT §5.1).
// ===========================================================================

/**
 * One rule per (materialized arm × first-hop relation × intermediate type).
 * The second hop of a rule may only read what exists as rows or facts
 * (invariant 6), so a computed walk/expansion anywhere in the target's
 * closure rejects the schema rather than letting the BFS silently derive
 * less than the planner.
 *
 * Keys. A rule's base names its own content (derived set, first hop,
 * intermediate, target and its second hop). A rule also depends on every
 * rule whose derived relation its second hop reads; the key appends a
 * fingerprint of the bases of all rules reachable that way (itself included,
 * so a recursive group of rules shares one closed set), so an edit anywhere
 * upstream changes the key and `rebuild` retires the old rows (CONTRACT §5.6).
 */
function compileRules({
  sets,
  inherits,
  factRelations,
  subjectTypes,
}: CompiledSets): TraversalRule[] {
  const bases: Omit<TraversalRule, "key">[] = [];
  const baseKeys: string[] = [];
  for (const [objectType, byName] of Object.entries(sets)) {
    for (const set of Object.values(byName)) {
      for (const arm of set.arms) {
        if (
          (arm.kind !== "expands" && arm.kind !== "walks") ||
          !arm.materialized
        )
          continue;
        const intermediateType =
          arm.kind === "expands" ? arm.subjectType : arm.viaType;
        const firstHopOf = arm.kind === "expands" ? set.name : arm.viaRelation;
        const written =
          arm.kind === "expands"
            ? `${arm.subjectType}#${arm.targetSet}`
            : `${arm.viaRelation}.${arm.targetSet}`;

        const inverses: { subjectType: string; relation: string }[] = [];
        for (const member of inherits[intermediateType][arm.targetSet]) {
          for (const inner of sets[intermediateType][member].arms) {
            if (
              (inner.kind === "walks" || inner.kind === "expands") &&
              !inner.materialized
            ) {
              throw new Error(
                `${ERR} \`${objectType}.${set.name}\`: materialized arm '${written}' reads \`${intermediateType}.${member}\`, which is computed at read time; materialize that arm too, or compute this one.`,
              );
            }
            if (
              inner.kind === "inverse" &&
              !inverses.some(
                (i) =>
                  i.subjectType === inner.subjectType &&
                  i.relation === inner.relation,
              )
            ) {
              inverses.push({
                subjectType: inner.subjectType,
                relation: inner.relation,
              });
            }
          }
        }

        // A first-hop relation that can never hold a fact of the intermediate
        // type would only produce a rule that never fires.
        for (const relation of factRelations[objectType][firstHopOf]) {
          if (!subjectTypes(objectType, relation).includes(intermediateType))
            continue;
          const secondHop = {
            relations: [...factRelations[intermediateType][arm.targetSet]],
            inverses,
          };
          const base =
            `${objectType}.${set.name}<=${relation}:${intermediateType}#${arm.targetSet}` +
            `(${secondHop.relations.join(",")};${inverses.map((i) => `${i.subjectType}#${i.relation}`).join(",")})`;
          if (baseKeys.includes(base)) continue;
          baseKeys.push(base);
          bases.push({
            objectType,
            derived: set.name,
            firstHop: { relation, intermediateType },
            secondHop,
          });
        }
      }
    }
  }

  // ρ reads σ when σ derives a relation on ρ's intermediate type that ρ's second hop reads.
  const reads = bases.map((rho) =>
    bases
      .map((sigma, j) => ({ sigma, j }))
      .filter(
        ({ sigma }) =>
          sigma.objectType === rho.firstHop.intermediateType &&
          rho.secondHop.relations.includes(sigma.derived),
      )
      .map(({ j }) => j),
  );
  const rules = bases.map((rule, i) => {
    const reached = new Set<number>([i]);
    const stack = [i];
    while (stack.length > 0) {
      for (const j of reads[stack.pop()!]) {
        if (!reached.has(j)) {
          reached.add(j);
          stack.push(j);
        }
      }
    }
    const upstream = [...reached].map((j) => baseKeys[j]).sort(byKey);
    return { key: `${baseKeys[i]}@${fnv1a(upstream.join("\n"))}`, ...rule };
  });
  return rules.sort((a, b) => byKey(a.key, b.key));
}

// ===========================================================================
// Lineage bounds (CONTRACT §4.7).
// ===========================================================================

/**
 * `maxLineage` of every set: the most facts one derivation can use, over
 * every arm of its inherits closure whether computed or materialized — facts
 * and inverse 1, walks/expands 1 + the far set's — or null when the set
 * reaches a cycle. A finite value above `maxDepth` is a schema error: such a
 * chain would meet the bound with no recursion to blame, so it is refused at
 * load and acyclic chains never meet the bound at runtime.
 */
function boundLineage(
  sets: Record<string, Record<string, CompiledSet>>,
  inherits: InheritsClosure,
  maxDepth: number,
): void {
  const id = (t: string, s: string) => `${t}#${s}`;
  const memo = new Map<string, number | null | "visiting">();
  const longest = (objectType: string, name: string): number | null => {
    const key = id(objectType, name);
    const known = memo.get(key);
    if (known === "visiting") return null; // on the stack: a cycle
    if (known !== undefined) return known;
    memo.set(key, "visiting");
    let best: number | null = 0;
    for (const member of inherits[objectType]?.[name] ?? []) {
      for (const arm of sets[objectType][member].arms) {
        let len: number | null;
        if (arm.kind === "facts" || arm.kind === "inverse") len = 1;
        else if (arm.kind === "inherits")
          continue; // its members are in the closure
        else {
          const far =
            arm.kind === "expands"
              ? longest(arm.subjectType, arm.targetSet)
              : longest(arm.viaType, arm.targetSet);
          len = far === null ? null : 1 + far;
        }
        best = best === null || len === null ? null : Math.max(best, len);
      }
    }
    memo.set(key, best);
    return best;
  };
  for (const [objectType, byName] of Object.entries(sets)) {
    for (const set of Object.values(byName)) {
      set.maxLineage = longest(objectType, set.name);
      if (set.maxLineage !== null && set.maxLineage > maxDepth) {
        throw new Error(
          `${ERR} the longest derivation of '${objectType}.${set.name}' uses ${set.maxLineage} facts, more than maxDepth (${maxDepth}). ` +
            `An acyclic chain must fit: raise maxDepth or shorten the chain.`,
        );
      }
    }
  }
}

/**
 * The subject types a fact written to `(objectType, relation)` may have:
 * the facts arms (declared, or implied by an expansion) of the relation and
 * of every relation it inherits. Empty for a permission or an unknown set.
 */
export function writableSubjectTypes(
  config: GraphConfig,
  objectType: string,
  relation: string,
): string[] {
  if (!config.sets[objectType]?.[relation]?.writable) return [];
  const types: string[] = [];
  for (const member of config.factRelations[objectType]?.[relation] ?? []) {
    for (const arm of config.sets[objectType][member].arms) {
      if (arm.kind === "facts" && !types.includes(arm.subjectType))
        types.push(arm.subjectType);
    }
  }
  return types;
}
