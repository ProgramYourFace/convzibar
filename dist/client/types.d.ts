import type { ObjectType as ConvexObjectType, PropertyValidators } from "convex/values";
/** `materialize('group#devices')` — the same arm, kept as rows by the BFS. */
export interface MaterializedArm {
    materialize: string;
}
/**
 * One arm of a relation as written in the schema: `'system_user'` facts,
 * `'admin'` inherits, `'group#viewer'` expands, `'parent.admin'` walks,
 * `'~device#parent'` inverse, or `materialize(arm)` of an expands or walks arm.
 */
export type SchemaArm = string | MaterializedArm;
export interface EntityDefinition {
    relations?: Record<string, SchemaArm[]>;
    /** Permission arms: the relation arms minus facts and `materialize`. */
    permissions?: Record<string, string[]>;
    propertyValidators?: Record<string, PropertyValidators>;
}
export interface ZbarSchema {
    entities: Record<string, EntityDefinition>;
}
export type BuiltZbarSchema<Entities extends Record<string, {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
}>> = {
    entities: {
        [E in keyof Entities]: {
            relations: Record<keyof Entities[E]["relations"] & string, SchemaArm[]>;
            permissions: Record<Entities[E]["permissions"] & string, string[]>;
            propertyValidators: Entities[E]["properties"];
        };
    };
};
export interface SubjectOrObject {
    type: string;
    id: string;
}
export type EntityPermissions<Schema extends ZbarSchema, ObjectType extends keyof Schema["entities"]> = Schema["entities"][ObjectType] extends {
    permissions: infer P;
} ? keyof P & string : never;
export type EntityRelations<Schema extends ZbarSchema, ObjectType extends keyof Schema["entities"]> = Schema["entities"][ObjectType] extends {
    relations: infer R;
} ? keyof R & string : never;
/**
 * Extract the property validators for a specific relation on an entity type.
 * Returns `never` if the relation has no properties defined.
 */
export type EntityRelationProperties<Schema extends ZbarSchema, ObjType extends keyof Schema["entities"], Relation extends string> = Schema["entities"][ObjType] extends {
    propertyValidators: infer PV;
} ? PV extends Record<string, PropertyValidators> ? Relation extends keyof PV ? ConvexObjectType<PV[Relation]> : never : never : never;
/**
 * Resolve the inferred property type for a relation.
 * Returns `undefined` when no properties are declared.
 */
export type ResolvedProperties<Schema extends ZbarSchema, OT extends keyof Schema["entities"] & string, Rel extends string> = EntityRelationProperties<Schema, OT, Rel> extends never ? undefined : EntityRelationProperties<Schema, OT, Rel>;
//# sourceMappingURL=types.d.ts.map