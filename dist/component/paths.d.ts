/**
 * Paths of an effective row (EXPANSION.md §1.1, §2.3). Pure.
 *
 * A path is `{ baseIds, rule }`: `baseIds` is the lineage (the sorted,
 * duplicate-free ids of the facts the derivation used) and `rule` the
 * `TraversalRule.key` that wrote it, or `'fact'` for a mirror.
 */
import type { EffectivePath } from "./types";
/** The rule tag of a fact's mirror path (CONTRACT §1). */
export declare const FACT_RULE = "fact";
/**
 * The most CURRENT paths one row stores (CONTRACT §5.2, EXPANSION.md P7):
 * `writePaths` leaves at most this many paths on a row, its mirror aside.
 */
export declare const MAX_PATHS = 32;
export declare function canonicalizePath(p: {
    baseIds: readonly string[];
    rule: string;
}): EffectivePath;
/**
 * The canonical id of a stored path, the `lineage.path` field: its sorted
 * fact ids and its rule. Two paths of one row are the same path iff their ids
 * are equal.
 */
export declare function pathId(p: {
    baseIds: readonly string[];
    rule?: string;
}): string;
/** The number of facts of the path with this id (fact ids contain no ',' or '/'). */
export declare function pathSize(id: string): number;
type Stored = {
    baseIds: string[];
    rule?: string;
};
type Merge<P extends Stored> = 
/** A current path's lineage is a subset of the incoming one: nothing to do. */
{
    kind: "dominated";
}
/** The row already holds `cap` CURRENT paths besides those the incoming one prunes. */
 | {
    kind: "full";
}
/**
 * `paths` replaces the row's paths; `pruned` were dropped: the supersets of
 * the new path, then the non-current paths evicted to stay within `cap`.
 */
 | {
    kind: "stored";
    path: EffectivePath;
    paths: (P | EffectivePath)[];
    pruned: P[];
};
/**
 * EXPANSION.md §2.3. Keep the row's paths an antichain under ⊆, within `cap`:
 *
 * - `incoming` is dominated when a CURRENT stored path (`isCurrent(p)`: a
 *   mirror, or a path of a rule of the config being applied with at most its
 *   `maxDepth` facts) has a lineage ⊆ it. A path of a retired rule (or one
 *   over a lowered bound) never dominates, so `rebuild` can store the
 *   replacement before it retires the old path (CONTRACT §5.6).
 * - otherwise every stored path whose lineage ⊇ `incoming`'s is pruned (it
 *   adds no liveness: any removal that kills `incoming` kills it too). Only
 *   CURRENT paths count against `cap` (`MAX_PATHS`; a mirror is stored
 *   whatever the count): `full` when the current ones left plus `incoming`
 *   exceed it. A non-current path never blocks a current one: the first
 *   non-current paths are evicted while the row would exceed `cap`.
 */
export declare function mergePath<P extends Stored>(existing: readonly P[], incoming: EffectivePath, isCurrent: (p: Stored) => boolean, cap?: number): Merge<P>;
export {};
//# sourceMappingURL=paths.d.ts.map