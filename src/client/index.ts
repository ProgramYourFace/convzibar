// Public API surface for the convzibar client.
// Implementation lives in topical sub-modules — this file re-exports only.

// Core types
export type {
  SchemaArm,
  MaterializedArm,
  EntityDefinition,
  ZbarSchema,
  BuiltZbarSchema,
  SubjectOrObject,
  EntityPermissions,
  EntityRelations,
  EntityRelationProperties,
  ResolvedProperties,
} from "./types";

// Schema builder
export {
  EntityBuilder,
  SchemaBuilder,
  createZbarSchema,
  materialize,
} from "./schema/builder";

// list() fluent interfaces
export type {
  ListInitial,
  ListWithObjectType,
  ListWithObjectInstance,
  ListObjectsNeedSubject,
  ListSubjectsNeedSubject,
  ListCollectable,
  ListFinal,
  ListMapped,
} from "./list/types";

// listDirect() fluent interfaces + result row
export type {
  DirectRelationship,
  ListDirectInitial,
  ListDirectWithObjectType,
  ListDirectWithObjectInstance,
  ListDirectObjectFiltered,
  ListDirectSubjectOnly,
  ListDirectCollectable,
  ListDirectFinal,
  ListDirectMapped,
} from "./list-direct/types";

// Zbar class + factory
export { Zbar, createZbar } from "./zbar/index";
