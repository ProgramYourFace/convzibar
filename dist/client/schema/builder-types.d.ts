/** `'parent.admin'` — walk one of this entity's relations, then take a set there. */
export type WalkArmString = `${string}.${string}`;
/** `'group#viewer'` (expands) or `'~device#parent'` (inverse). */
export type HashArmString = `${string}#${string}`;
/** An arm accepted by `.permission()`: an inherited set, a walk, an expansion or an inverse. */
export type PermissionArmString<Relations, Permissions extends string> = (keyof Relations & string) | Permissions | WalkArmString | HashArmString;
//# sourceMappingURL=builder-types.d.ts.map