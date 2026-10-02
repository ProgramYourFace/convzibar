import type { PropertyValidators } from "convex/values";
import type { BuiltZbarSchema, MaterializedArm, SchemaArm } from "../types";
import type { HashArmString, PermissionArmString, WalkArmString } from "./builder-types";
type EntityRecord = Record<string, {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
}>;
interface EntityDef {
    relations: Record<string, SchemaArm[]>;
    permissions: Record<string, string[]>;
    propertyValidators: Record<string, PropertyValidators>;
}
/**
 * Mark an expands (`'group#devices'`) or walks (`'parent.admin'`) arm as
 * materialized: the engine keeps its contribution as rows at write time
 * instead of computing it at read time. Either way the arm means the same
 * thing (CONTRACT.md §4); this only moves work from reads to writes.
 */
export declare function materialize<A extends WalkArmString | HashArmString>(arm: A): {
    materialize: A;
};
export declare class EntityBuilder<EntName extends string, Relations extends Record<string, string> = {}, Permissions extends string = never, Properties extends Record<string, PropertyValidators> = {}> {
    _entity: EntName;
    _relations: Relations;
    _permissions: Permissions;
    _properties: Properties;
    def: EntityDef;
    /**
     * Declare a relation. Arms: `'system_user'` facts, `'admin'` inherits,
     * `'group#viewer'` expands, `'parent.admin'` walks, `'~device#parent'`
     * inverse, or `materialize(...)` of an expands/walks arm. With no arms the
     * relation is an empty set.
     */
    relation<RelName extends string>(name: RelName, ...arms: (string | MaterializedArm)[]): EntityBuilder<EntName, Relations & Record<RelName, string>, Permissions, Properties>;
    /**
     * Declare a permission: a set nothing is ever written to. Same arms as a
     * relation except facts and `materialize` (CONTRACT.md §2.3).
     */
    permission<PermName extends string>(name: PermName, ...arms: PermissionArmString<Relations, Permissions>[]): EntityBuilder<EntName, Relations, Permissions | PermName, Properties>;
    /**
     * Define typed properties for a relation using Convex validators.
     *
     * Properties are stored on facts and returned by `.listDirect()`. They are
     * validated at write time by the client before being persisted.
     */
    properties<RelName extends keyof Relations & string, P extends PropertyValidators>(relation: RelName, validators: P): EntityBuilder<EntName, Relations, Permissions, Properties & Record<RelName, P>>;
}
export declare class SchemaBuilder<Entities extends EntityRecord = {}> {
    _schema: {
        entities: Record<string, EntityDef>;
    };
    /**
     * Declare an entity. Without a callback it is a pure subject (an entity
     * with no sets, e.g. `linked_recipient`). Entities may be declared in any
     * order: names are resolved when the schema is compiled.
     */
    entity<Name extends string, Rel extends Record<string, string> = {}, Perm extends string = never, Props extends Record<string, PropertyValidators> = {}>(name: Name, build?: (e: EntityBuilder<Name, {}, never, {}>) => EntityBuilder<Name, Rel, Perm, Props>): SchemaBuilder<Entities & Record<Name, {
        relations: Rel;
        permissions: Perm;
        properties: Props;
    }>>;
    /** The schema object. Names are resolved (and errors raised) when it is compiled. */
    build(): BuiltZbarSchema<Entities>;
}
export declare function createZbarSchema(): SchemaBuilder<{}>;
export {};
//# sourceMappingURL=builder.d.ts.map