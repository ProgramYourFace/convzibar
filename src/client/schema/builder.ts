import type { PropertyValidators } from "convex/values";
import type { BuiltZbarSchema, MaterializedArm, SchemaArm } from "../types";
import type {
  HashArmString,
  PermissionArmString,
  WalkArmString,
} from "./builder-types";

type EntityRecord = Record<
  string,
  {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
  }
>;

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
export function materialize<A extends WalkArmString | HashArmString>(
  arm: A,
): { materialize: A } {
  return { materialize: arm };
}

/** A name is declared once per entity (relations and permissions share one namespace). */
function declareOnce(def: EntityDef, name: string) {
  if (name in def.relations || name in def.permissions) {
    throw new Error(
      `Zbar Schema Error: '${name}' is declared twice on one entity. A set has one name.`,
    );
  }
}

export class EntityBuilder<
  EntName extends string,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  Relations extends Record<string, string> = {},
  Permissions extends string = never,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  Properties extends Record<string, PropertyValidators> = {},
> {
  declare _entity: EntName;
  declare _relations: Relations;
  declare _permissions: Permissions;
  declare _properties: Properties;

  public def: EntityDef = {
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
  relation<RelName extends string>(
    name: RelName,
    ...arms: (string | MaterializedArm)[]
  ): EntityBuilder<
    EntName,
    Relations & Record<RelName, string>,
    Permissions,
    Properties
  > {
    declareOnce(this.def, name);
    this.def.relations[name] = [...arms];
    return this as any;
  }

  /**
   * Declare a permission: a set nothing is ever written to. Same arms as a
   * relation except facts and `materialize` (CONTRACT.md §2.3).
   */
  permission<PermName extends string>(
    name: PermName,
    ...arms: PermissionArmString<Relations, Permissions>[]
  ): EntityBuilder<EntName, Relations, Permissions | PermName, Properties> {
    declareOnce(this.def, name);
    this.def.permissions[name] = [...arms];
    return this as any;
  }

  /**
   * Define typed properties for a relation using Convex validators.
   *
   * Properties are stored on facts and returned by `.listDirect()`. They are
   * validated at write time by the client before being persisted.
   */
  properties<
    RelName extends keyof Relations & string,
    P extends PropertyValidators,
  >(
    relation: RelName,
    validators: P,
  ): EntityBuilder<
    EntName,
    Relations,
    Permissions,
    Properties & Record<RelName, P>
  > {
    this.def.propertyValidators[relation] = validators;
    return this as any;
  }
}

export class SchemaBuilder<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  Entities extends EntityRecord = {},
> {
  public _schema: { entities: Record<string, EntityDef> } = { entities: {} };

  /**
   * Declare an entity. Without a callback it is a pure subject (an entity
   * with no sets, e.g. `linked_recipient`). Entities may be declared in any
   * order: names are resolved when the schema is compiled.
   */
  entity<
    Name extends string,
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    Rel extends Record<string, string> = {},
    Perm extends string = never,
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    Props extends Record<string, PropertyValidators> = {},
  >(
    name: Name,
    build?: (
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      e: EntityBuilder<Name, {}, never, {}>,
    ) => EntityBuilder<Name, Rel, Perm, Props>,
  ): SchemaBuilder<
    Entities &
      Record<Name, { relations: Rel; permissions: Perm; properties: Props }>
  > {
    this._schema.entities[name] = build
      ? build(new EntityBuilder()).def
      : { relations: {}, permissions: {}, propertyValidators: {} };
    return this as any;
  }

  /** The schema object. Names are resolved (and errors raised) when it is compiled. */
  build(): BuiltZbarSchema<Entities> {
    return this._schema as any;
  }
}

export function createZbarSchema() {
  return new SchemaBuilder();
}
