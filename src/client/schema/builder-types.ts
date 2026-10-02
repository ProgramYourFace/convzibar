// Type-level arm shapes for the schema builder.
//
// Relation arms are plain strings at the type level: a facts arm may name an
// entity declared later in the chain (entities resolve at compile time, not
// in declaration order), so a template-literal union over the entities seen
// so far would reject valid schemas. The compiler checks every name when the
// schema is loaded. Permission arms never name an entity, so they keep a
// cheap typed union that catches a misspelt inherited set at compile time.

/** `'parent.admin'` — walk one of this entity's relations, then take a set there. */
export type WalkArmString = `${string}.${string}`;

/** `'group#viewer'` (expands) or `'~device#parent'` (inverse). */
export type HashArmString = `${string}#${string}`;

/** An arm accepted by `.permission()`: an inherited set, a walk, an expansion or an inverse. */
export type PermissionArmString<Relations, Permissions extends string> =
  | (keyof Relations & string)
  | Permissions
  | WalkArmString
  | HashArmString;
