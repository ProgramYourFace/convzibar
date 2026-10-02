/**
 * Mark an expands (`'group#devices'`) or walks (`'parent.admin'`) arm as
 * materialized: the engine keeps its contribution as rows at write time
 * instead of computing it at read time. Either way the arm means the same
 * thing (CONTRACT.md §4); this only moves work from reads to writes.
 */
export function materialize(arm) {
    return { materialize: arm };
}
/** A name is declared once per entity (relations and permissions share one namespace). */
function declareOnce(def, name) {
    if (name in def.relations || name in def.permissions) {
        throw new Error(`Zbar Schema Error: '${name}' is declared twice on one entity. A set has one name.`);
    }
}
export class EntityBuilder {
    def = {
        relations: {},
        permissions: {},
        propertyValidators: {},
    };
    /**
     * Declare a relation. Arms: `'system_user'` facts, `'admin'` inherits,
     * `'group#viewer'` expands, `'parent.admin'` walks, `'~device#parent'`
     * inverse, or `materialize(...)` of an expands/walks arm. With no arms the
     * relation is an empty set.
     */
    relation(name, ...arms) {
        declareOnce(this.def, name);
        this.def.relations[name] = [...arms];
        return this;
    }
    /**
     * Declare a permission: a set nothing is ever written to. Same arms as a
     * relation except facts and `materialize` (CONTRACT.md §2.3).
     */
    permission(name, ...arms) {
        declareOnce(this.def, name);
        this.def.permissions[name] = [...arms];
        return this;
    }
    /**
     * Define typed properties for a relation using Convex validators.
     *
     * Properties are stored on facts and returned by `.listDirect()`. They are
     * validated at write time by the client before being persisted.
     */
    properties(relation, validators) {
        this.def.propertyValidators[relation] = validators;
        return this;
    }
}
export class SchemaBuilder {
    _schema = { entities: {} };
    /**
     * Declare an entity. Without a callback it is a pure subject (an entity
     * with no sets, e.g. `linked_recipient`). Entities may be declared in any
     * order: names are resolved when the schema is compiled.
     */
    entity(name, build) {
        this._schema.entities[name] = build
            ? build(new EntityBuilder()).def
            : { relations: {}, permissions: {}, propertyValidators: {} };
        return this;
    }
    /** The schema object. Names are resolved (and errors raised) when it is compiled. */
    build() {
        return this._schema;
    }
}
export function createZbarSchema() {
    return new SchemaBuilder();
}
//# sourceMappingURL=builder.js.map