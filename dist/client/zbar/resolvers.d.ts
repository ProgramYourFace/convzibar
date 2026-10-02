import type { ZbarInternal } from "../internal";
/**
 * `set` plus every set it transitively inherits (CONTRACT §2.4), e.g. `owner`
 * → `[owner, admin, viewer]` when `owner` inherits `admin` inherits `viewer`.
 * Relations and permissions are both sets. Empty for an unknown name.
 */
export declare function resolveRelationInheritance(z: ZbarInternal, objectType: string, set: string): string[];
/**
 * The writable relations in `set`'s closure: what a first hop through `set`
 * reads facts of (CONTRACT §2.1).
 */
export declare function resolveFactRelations(z: ZbarInternal, objectType: string, set: string): string[];
//# sourceMappingURL=resolvers.d.ts.map