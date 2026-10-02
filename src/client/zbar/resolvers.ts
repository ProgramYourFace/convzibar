import type { ZbarInternal } from "../internal";

// Reads of the closures the compiler precomputed (`GraphConfig.inherits`,
// `GraphConfig.factRelations`), so local inheritance can never be derived two
// different ways.

/**
 * `set` plus every set it transitively inherits (CONTRACT §2.4), e.g. `owner`
 * → `[owner, admin, viewer]` when `owner` inherits `admin` inherits `viewer`.
 * Relations and permissions are both sets. Empty for an unknown name.
 */
export function resolveRelationInheritance(
  z: ZbarInternal,
  objectType: string,
  set: string,
): string[] {
  return z.graphConfig.inherits[objectType]?.[set] ?? [];
}

/**
 * The writable relations in `set`'s closure: what a first hop through `set`
 * reads facts of (CONTRACT §2.1).
 */
export function resolveFactRelations(
  z: ZbarInternal,
  objectType: string,
  set: string,
): string[] {
  return z.graphConfig.factRelations[objectType]?.[set] ?? [];
}
