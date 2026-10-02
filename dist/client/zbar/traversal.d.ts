import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
export interface Entity {
    type: string;
    id: string;
}
type Ctx = QueryCtx | ActionCtx;
/** Each id with the fewest facts of the derivations found for it (CONTRACT §4.7). */
type Levels = Map<string, number>;
export interface Traversal {
    /**
     * Index reads on the cheapest path that can answer a check: a leaf is 1, a
     * `Compose` the sum of its hops, a `Union` the min of its children. `Union.of`
     * sorts children by it so narrowing probes the cheap branches first.
     */
    readonly cost: number;
    check(ctx: Ctx, subject: Entity, object: Entity): Promise<boolean>;
    /** Of the candidate object ids, which does `subject` reach? */
    checkBatch(ctx: Ctx, subject: Entity, objectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    /** Of the candidate subject ids, which reach `object`? */
    checkBatchSubjects(ctx: Ctx, object: Entity, subjectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    /** Every `objectType` id `subject` reaches. */
    expandObjects(ctx: Ctx, subject: Entity, objectType: string): Promise<Set<string>>;
    /** Every `subjectType` id reaching `object`. */
    expandSubjects(ctx: Ctx, object: Entity, subjectType: string): Promise<Set<string>>;
    /** Union of `expandObjects` over many subjects, batched so chained hops stay O(depth) reads. */
    expandObjectsFromMany(ctx: Ctx, subjects: readonly Entity[], objectType: string): Promise<Set<string>>;
    /** Union of `expandSubjects` over many objects. */
    expandSubjectsFromMany(ctx: Ctx, objects: readonly Entity[], subjectType: string): Promise<Set<string>>;
    checkLevels(ctx: Ctx, subject: Entity, objectType: string, ids: readonly string[]): Promise<Levels>;
    objectLevels(ctx: Ctx, subjects: readonly Entity[], objectType: string): Promise<Levels>;
    subjectLevels(ctx: Ctx, objects: readonly Entity[], subjectType: string): Promise<Levels>;
}
type Far = {
    type: string;
    ids?: readonly string[];
};
/** One fact or row, normalised; `facts` is its lineage length (1 for a fact, a row's shortest path). */
type Edge = {
    subjectId: string;
    objectId: string;
    facts: number;
    properties?: unknown;
};
/** Facts read from either end; exported for `listDirect`. */
export declare const readFactsForward: (z: ZbarInternal, ctx: Ctx, subjects: readonly Entity[], relations: readonly string[], far: Far) => Promise<Edge[]>;
export declare const readFactsReverse: (z: ZbarInternal, ctx: Ctx, objects: readonly Entity[], relations: readonly string[], far: Far) => Promise<Edge[]>;
/**
 * Compile `(objectType, set)` — a relation or a permission — into a plan
 * (CONTRACT §3). Memoised per compiled config. An unknown set is `EMPTY`.
 *
 *   Union( Materialised(writable members ∪ members with materialized arms),
 *          Inverse per inverse arm,
 *          Compose(first hop = facts, planSet(T, target)) per computed walks/expands arm )
 *
 * A set in a recursive component is a `Closure` over the component instead;
 * any other set that reaches a cycle (`maxLineage` null) is that union
 * wrapped in `Counted`, so its answers are settled by fact count (CONTRACT
 * §4.7). The far-set graph outside cycles is a DAG, so the recursion through
 * `planSet` terminates.
 */
export declare function planSet(z: ZbarInternal, objectType: string, set: string): Traversal;
/**
 * Granted permissions, in input order. One batched `Materialised` read covers
 * every permission's materialised members (a hit there is a grant: those rows
 * are a subset of the set); the remaining permissions run their other
 * branches, each distinct branch at most once (plans are memoised by
 * structure, so permissions sharing an arm share the branch object).
 */
export declare function evaluateManyPermissions(z: ZbarInternal, ctx: Ctx, subject: Entity, object: Entity, permissions: readonly string[]): Promise<string[]>;
/** Objects of `objectType` that `subject` holds `plan` on, within the structural scope of `via[last]`. */
export declare function collectViaObjects(z: ZbarInternal, ctx: Ctx, plan: Traversal, subject: Entity, via: readonly Entity[], objectType: string): Promise<Set<string>>;
/** Subjects of `subjectType` holding `plan` on `object`, within the structural scope of `via[0]`. */
export declare function collectViaSubjects(z: ZbarInternal, ctx: Ctx, plan: Traversal, object: Entity, via: readonly Entity[], subjectType: string): Promise<Set<string>>;
export {};
//# sourceMappingURL=traversal.d.ts.map