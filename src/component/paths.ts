/**
 * Paths of an effective row (EXPANSION.md §1.1, §2.3). Pure.
 *
 * A path is `{ baseIds, rule }`: `baseIds` is the lineage (the sorted,
 * duplicate-free ids of the facts the derivation used) and `rule` the
 * `TraversalRule.key` that wrote it, or `'fact'` for a mirror.
 */

import type { EffectivePath } from "./types";

/** The rule tag of a fact's mirror path (CONTRACT §1). */
export const FACT_RULE = "fact";

/**
 * The most CURRENT paths one row stores (CONTRACT §5.2, EXPANSION.md P7):
 * `writePaths` leaves at most this many paths on a row, its mirror aside.
 */
export const MAX_PATHS = 32;

export function canonicalizePath(p: {
  baseIds: readonly string[];
  rule: string;
}): EffectivePath {
  return { baseIds: [...new Set(p.baseIds)].sort(), rule: p.rule };
}

/**
 * The canonical id of a stored path, the `lineage.path` field: its sorted
 * fact ids and its rule. Two paths of one row are the same path iff their ids
 * are equal.
 */
export function pathId(p: {
  baseIds: readonly string[];
  rule?: string;
}): string {
  return `${p.baseIds.join(",")}/${p.rule ?? ""}`;
}

/** The number of facts of the path with this id (fact ids contain no ',' or '/'). */
export function pathSize(id: string): number {
  return id.slice(0, id.indexOf("/")).split(",").length;
}

const subset = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(b);
  return a.every((id) => set.has(id));
};

type Stored = { baseIds: string[]; rule?: string };

type Merge<P extends Stored> =
  /** A current path's lineage is a subset of the incoming one: nothing to do. */
  | { kind: "dominated" }
  /** The row already holds `cap` CURRENT paths besides those the incoming one prunes. */
  | { kind: "full" }
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
export function mergePath<P extends Stored>(
  existing: readonly P[],
  incoming: EffectivePath,
  isCurrent: (p: Stored) => boolean,
  cap: number = MAX_PATHS,
): Merge<P> {
  const path = canonicalizePath(incoming);
  if (existing.some((p) => isCurrent(p) && subset(p.baseIds, path.baseIds))) {
    return { kind: "dominated" };
  }
  const supersets = existing.filter((p) => subset(path.baseIds, p.baseIds));
  const kept = existing.filter((p) => !supersets.includes(p));
  if (kept.filter((p) => isCurrent(p)).length + 1 > cap)
    return { kind: "full" };
  const evicted: P[] = [];
  for (const p of kept) {
    if (kept.length - evicted.length + 1 <= cap) break;
    if (!isCurrent(p)) evicted.push(p);
  }
  return {
    kind: "stored",
    path,
    paths: [...kept.filter((p) => !evicted.includes(p)), path],
    pruned: [...supersets, ...evicted],
  };
}
