import type { ActionCtx, QueryCtx } from "../internal";
import type { EntityPermissions, EntityRelations, ZbarSchema } from "../types";
/**
 * Entry point returned by `zbar.list()`. Call `.object()` to begin building
 * a list query.
 *
 * - `.object("device")` — list **objects** of that type (subject needs `{type, id}`)
 * - `.object({ type: "device", id })` — list **subjects** related to that object
 */
export interface ListInitial<Schema extends ZbarSchema> {
    object<OT extends keyof Schema["entities"] & string>(objectType: OT): ListWithObjectType<Schema, OT>;
    object<OT extends keyof Schema["entities"] & string>(object: {
        type: OT;
        id: string;
    }): ListWithObjectInstance<Schema, OT>;
}
/** After `.object(type)` — listing objects. Pick a relation or permission. */
export interface ListWithObjectType<Schema extends ZbarSchema, OT extends keyof Schema["entities"] & string> {
    relation<R extends EntityRelations<Schema, OT>>(relation: R): ListObjectsNeedSubject<Schema>;
    permission<P extends EntityPermissions<Schema, OT>>(permission: P): ListObjectsNeedSubject<Schema>;
}
/** After `.object({type, id})` — listing subjects. Pick a relation or permission. */
export interface ListWithObjectInstance<Schema extends ZbarSchema, OT extends keyof Schema["entities"] & string> {
    relation<R extends EntityRelations<Schema, OT>>(relation: R): ListSubjectsNeedSubject<Schema>;
    permission<P extends EntityPermissions<Schema, OT>>(permission: P): ListSubjectsNeedSubject<Schema>;
}
/** Listing objects — subject must be a full `{type, id}` pair. */
export interface ListObjectsNeedSubject<Schema extends ZbarSchema> {
    subject<ST extends keyof Schema["entities"] & string>(subject: {
        type: ST;
        id: string;
    }): ListCollectable<Schema, {
        objectId: string;
    }>;
}
/** Listing subjects — subject is just a type string. */
export interface ListSubjectsNeedSubject<Schema extends ZbarSchema> {
    subject<ST extends keyof Schema["entities"] & string>(subjectType: ST): ListCollectable<Schema, {
        subjectId: string;
    }>;
}
/** Ready to collect, with optional `.via()` filtering and `.map()`. */
export interface ListCollectable<Schema extends ZbarSchema, Result> {
    via<VT extends keyof Schema["entities"] & string>(...entities: ({
        type: VT;
        id: string;
    } | null | undefined)[]): ListFinal<Result>;
    map<T>(fn: (item: Result) => T | Promise<T>): ListMapped<T>;
    collect(ctx: QueryCtx | ActionCtx): Promise<Result[]>;
}
/** After `.via()` — can `.map()` or `.collect()`. */
export interface ListFinal<Result> {
    map<T>(fn: (item: Result) => T | Promise<T>): ListMapped<T>;
    collect(ctx: QueryCtx | ActionCtx): Promise<Result[]>;
}
/** After `.map()` — terminal, can only `.collect()`. */
export interface ListMapped<T> {
    collect(ctx: QueryCtx | ActionCtx): Promise<T[]>;
}
//# sourceMappingURL=types.d.ts.map