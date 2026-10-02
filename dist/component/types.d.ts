/**
 * The compiled graph configuration (v2).
 *
 * The schema builder (`lib/zbar/schema/builder.ts`) produces a `ZbarSchema`;
 * the compiler (`helpers.ts` `parseSchemaToGraphConfig`) turns it into this
 * `GraphConfig`. BOTH evaluators read only this object:
 *
 *   - the read-time planner (`lib/zbar/traversal.ts`) compiles `sets` into
 *     Traversal trees;
 *   - the write-time BFS (`expand.ts`, `mutations.ts`) applies `rules`.
 *
 * The contract both must implement is `CONTRACT.md` next to this file. In one
 * line: a materialized arm means exactly what the same arm means when computed.
 */
/** `'system_user'` — subjects of this type written directly as facts. */
interface FactsArm {
    kind: "facts";
    subjectType: string;
}
/** `'admin'` — everything in the entity's `admin` set (a relation or a permission). */
interface InheritsArm {
    kind: "inherits";
    set: string;
}
/**
 * `'group#viewer'` — for each `group` in the FIRST HOP of this set, that
 * group's full `viewer` set. The first hop is the facts of this set and of
 * every relation it inherits whose subject type is `subjectType`.
 * `subjectType` is also made a writable fact type of this set (S2).
 */
interface ExpandsArm {
    kind: "expands";
    subjectType: string;
    /** A relation on `subjectType` (never a permission: CONTRACT §2.3). */
    targetSet: string;
    materialized: boolean;
}
/**
 * `'parent.admin'` — for each object in the FIRST HOP of this entity's
 * `viaRelation` (its facts and inherited facts) whose type is `viaType`, that
 * object's full `targetSet`. One compiled arm per declared `viaType`.
 */
interface WalksArm {
    kind: "walks";
    viaRelation: string;
    viaType: string;
    /** A relation or permission on `viaType`. */
    targetSet: string;
    materialized: boolean;
}
/** `'~device#parent'` — the `subjectType` nodes `x` with a fact `(thisObject, relation, x)`. */
interface InverseArm {
    kind: "inverse";
    subjectType: string;
    /** The relation on `subjectType` whose fact has this object as SUBJECT. */
    relation: string;
}
export type CompiledArm = FactsArm | InheritsArm | ExpandsArm | WalksArm | InverseArm;
/** A relation (`writable: true`) or a permission (`writable: false`) on one entity type. */
export interface CompiledSet {
    objectType: string;
    name: string;
    writable: boolean;
    arms: CompiledArm[];
    /**
     * The most facts one derivation of this set can use, counting every arm
     * whether computed or materialized (facts and inverse 1; walks/expands 1 +
     * the far set's); `null` when the set reaches a cycle (CONTRACT §4.7). The
     * compiler rejects a schema where a non-null value exceeds `maxDepth`, so
     * only sets that reach a cycle can meet the bound at runtime. Which sets
     * form a read-time cycle (a `Closure`) is the planner's own SCC (§3).
     */
    maxLineage: number | null;
}
/**
 * `inherits[objectType][set]` = `set` itself plus every set it transitively
 * inherits through `inherits` arms, in declaration order, deduplicated.
 * Relations AND permissions may appear; `factRelations` is the subset that is
 * writable (what a first hop reads).
 */
export type InheritsClosure = Record<string, Record<string, string[]>>;
export interface TraversalRule {
    /**
     * Part of every derived row's path (`EffectivePath.rule`), so `rebuild` can
     * retire the paths of rules that no longer exist. `base@fingerprint`: the
     * base names the rule's own content, the fingerprint hashes the bases of
     * every rule whose derived relation this rule's second hop reads,
     * transitively (CONTRACT §5.1), so an upstream edit changes this key too.
     */
    key: string;
    objectType: string;
    /** The relation on `objectType` that gains rows. Always a relation (permissions are never materialized). */
    derived: string;
    firstHop: {
        /** The fact relation on `objectType` read for the first hop (the derived relation or one it inherits, for expands; the via relation or one it inherits, for walks). */
        relation: string;
        intermediateType: string;
    };
    secondHop: {
        /** Relations on `intermediateType` read from `effectiveRelationships` (the target set's inherits closure, writable members only, plus materialized members). */
        relations: string[];
        /** Inverse arms in the target set's closure, read from the facts index: nodes `x:subjectType` with a fact `(M, relation, x)`. */
        inverses: {
            subjectType: string;
            relation: string;
        }[];
    };
}
export interface GraphConfig {
    version: 2;
    /** `sets[objectType][name]`. */
    sets: Record<string, Record<string, CompiledSet>>;
    inherits: InheritsClosure;
    /** Writable members of `inherits`, per set: `factRelations[objectType][set]`. */
    factRelations: InheritsClosure;
    rules: TraversalRule[];
    /**
     * The most facts in one derivation's lineage, on both sides (CONTRACT
     * §4.7): the BFS never writes a longer path, a `Closure` throws when the
     * hit it finds needs a longer one. Acyclic chains never reach it: the
     * compiler checks `maxLineage ≤ maxDepth` at load. Default 16.
     */
    maxDepth: number;
    /** Budget units one transaction may spend before handing the rest to a cursor continuation (EXPANSION.md §5). Default 1000. */
    writeBudget: number;
    /**
     * Test-time driver: park every cursor in the `mockWorkpool` table so a test
     * chooses which chunk runs next (CONTRACT §6). The proofs of EXPANSION.md §6
     * interleave chunks this way.
     */
    mockWorkpool?: boolean;
}
/**
 * One derivation of an effective row. `baseIds` are the ids of every fact the
 * derivation depends on (its lineage, sorted, deduplicated); `rule` is the
 * `TraversalRule.key` that produced it, or `'fact'` for the mirror of a fact.
 */
export interface EffectivePath {
    baseIds: string[];
    rule: string;
}
export {};
//# sourceMappingURL=types.d.ts.map