import type { ActionCtx, QueryCtx } from "../internal";
import type { EntityPermissions, EntityRelations, ZbarSchema } from "../types";

/** Result row from a direct relationship query. */
export interface DirectRelationship {
  subject: { type: string; id: string };
  relation: string;
  object: { type: string; id: string };
  properties?: unknown;
}

/**
 * Entry point returned by `zbar.listDirect()`. Provide `.object()`,
 * `.subject()`, or both to scope the query.
 */
export interface ListDirectInitial<Schema extends ZbarSchema> {
  object<OT extends keyof Schema["entities"] & string>(
    objectType: OT,
  ): ListDirectWithObjectType<Schema, OT>;
  object<OT extends keyof Schema["entities"] & string>(object: {
    type: OT;
    id: string;
  }): ListDirectWithObjectInstance<Schema, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectSubjectOnly<Schema>;
  subject<ST extends keyof Schema["entities"] & string>(subject: {
    type: ST;
    id: string;
  }): ListDirectSubjectOnly<Schema>;
}

export interface ListDirectWithObjectType<
  Schema extends ZbarSchema,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, OT>;
  subject<ST extends keyof Schema["entities"] & string>(subject: {
    type: ST;
    id: string;
  }): ListDirectCollectable<Schema, OT>;
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListDirectObjectFiltered<Schema, OT>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectObjectFiltered<Schema, OT>;
  map<T>(fn: (item: DirectRelationship) => T | Promise<T>): ListDirectMapped<T>;
  collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]>;
}

export interface ListDirectWithObjectInstance<
  Schema extends ZbarSchema,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, OT>;
  subject<ST extends keyof Schema["entities"] & string>(subject: {
    type: ST;
    id: string;
  }): ListDirectCollectable<Schema, OT>;
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListDirectObjectFiltered<Schema, OT>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectObjectFiltered<Schema, OT>;
  map<T>(fn: (item: DirectRelationship) => T | Promise<T>): ListDirectMapped<T>;
  collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]>;
}

export interface ListDirectObjectFiltered<
  Schema extends ZbarSchema,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, OT>;
  subject<ST extends keyof Schema["entities"] & string>(subject: {
    type: ST;
    id: string;
  }): ListDirectCollectable<Schema, OT>;
  map<T>(fn: (item: DirectRelationship) => T | Promise<T>): ListDirectMapped<T>;
  collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]>;
}

export interface ListDirectSubjectOnly<Schema extends ZbarSchema> {
  object<OT extends keyof Schema["entities"] & string>(
    objectType: OT,
  ): ListDirectCollectable<Schema, OT>;
  object<OT extends keyof Schema["entities"] & string>(object: {
    type: OT;
    id: string;
  }): ListDirectCollectable<Schema, OT>;
  map<T>(fn: (item: DirectRelationship) => T | Promise<T>): ListDirectMapped<T>;
  collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]>;
}

export interface ListDirectCollectable<
  Schema extends ZbarSchema,
  OT extends keyof Schema["entities"] & string,
> {
  relation<R extends EntityRelations<Schema, OT>>(relation: R): ListDirectFinal;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectFinal;
  map<T>(fn: (item: DirectRelationship) => T | Promise<T>): ListDirectMapped<T>;
  collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]>;
}

export interface ListDirectFinal {
  map<T>(fn: (item: DirectRelationship) => T | Promise<T>): ListDirectMapped<T>;
  collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]>;
}

export interface ListDirectMapped<T> {
  collect(ctx: QueryCtx | ActionCtx): Promise<T[]>;
}
