import type { GraphConfig } from "../../component/types";
import type { ActionCtx, MutationCtx, QueryCtx } from "../internal";
import type { EntityPermissions, EntityRelations, ResolvedProperties, ZbarSchema } from "../types";
import type { ListDirectInitial } from "../list-direct/types";
import type { ListInitial } from "../list/types";
/** CONTRACT.md §6. */
interface ZbarOptions<Schema extends ZbarSchema> {
    schema: Schema;
    /**
     * Budget units one transaction may spend materializing (about one row
     * written each) before the rest continues in the workpool from a cursor.
     * The fact and its mirror are always written in the caller's transaction.
     * Defaults to 1000.
     */
    writeBudget?: number;
    /**
     * The most facts one derivation may use, on both sides (CONTRACT §4.7). A
     * write never stores a longer path and records an `expansionFailures` row;
     * a recursive read throws when the hit it finds needs a longer one. An
     * acyclic chain longer than this is a schema error at construction.
     * Defaults to 16.
     */
    maxDepth?: number;
}
/**
 * Create a new Zbar client instance.
 */
export declare function createZbar<Schema extends ZbarSchema>(component: any, options: ZbarOptions<Schema>): Zbar<Schema>;
export declare class Zbar<Schema extends ZbarSchema> {
    component: any;
    private options;
    private _internal;
    /** Whether this instance has registered its config with the component yet. */
    private _configRegistered;
    constructor(component: any, options: ZbarOptions<Schema>);
    /**
     * The compiled graph configuration. Exposed for advanced use cases and a
     * handful of tests that inspect it or set `mockWorkpool`.
     */
    get graphConfig(): GraphConfig;
    /** Stable content hash of the compiled config (mutations ship this). */
    get configHash(): string;
    /**
     * Determine if a subject has a specific relationship with an object.
     */
    hasRelationship<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }): Promise<boolean>;
    can<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Permission extends EntityPermissions<Schema, ObjectType>>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, permission: Permission, object: {
        type: ObjectType;
        id: string;
    }): Promise<boolean>;
    /**
     * Every permission the subject holds on the object, in declaration order:
     * one batched read of every permission's materialised members, then each
     * distinct remaining branch at most once.
     */
    getPermissions<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, object: {
        type: ObjectType;
        id: string;
    }): Promise<EntityPermissions<Schema, ObjectType>[]>;
    /** Fluent query builder for listing objects or subjects. */
    list(): ListInitial<Schema>;
    /** Fluent query builder for listing **direct** (base) relationships. */
    listDirect(): ListDirectInitial<Schema>;
    /**
     * Run a component write mutation, shipping the full compiled config only
     * until the component has registered it (once per instance); thereafter
     * only the hash travels.
     *
     * `_configRegistered` is client-side memory of server-side state, so it can
     * go stale: the registering transaction may roll back after the flag flips
     * (parent mutation throws, OCC retry), or component data may be wiped or
     * restored while a warm isolate still holds this instance. When the
     * component reports the hash unknown, resend the full config once instead
     * of failing every subsequent write from this instance.
     */
    private _runWrite;
    /**
     * Add a relationship between a subject and an object. If the relation has
     * schema-defined properties, pass them via `options.properties`.
     */
    addRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }, options?: {
        properties?: ResolvedProperties<Schema, ObjectType, Relation & string> extends undefined ? never : ResolvedProperties<Schema, ObjectType, Relation & string>;
    }): Promise<string>;
    /**
     * Add a relationship, clearing any existing relationships between the
     * subject and object atomically.
     */
    setRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }, options?: {
        properties?: ResolvedProperties<Schema, ObjectType, Relation & string> extends undefined ? never : ResolvedProperties<Schema, ObjectType, Relation & string>;
    }): Promise<string>;
    /** Remove a relationship between a subject and an object. */
    removeRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }): Promise<boolean>;
    /** Delete an entity and all its associated relationships. */
    deleteEntity<EntityType extends keyof Schema["entities"] & string>(ctx: MutationCtx | ActionCtx, entity: {
        type: EntityType;
        id: string;
    }): Promise<{
        relationshipsRemoved: number;
        effectiveRelationshipsRemoved: number;
    }>;
    /**
     * Re-derive every materialized row under this instance's config, then
     * retire every path it does not justify (CONTRACT §5.6). The component also
     * enqueues this itself whenever a write changes the active config (a new
     * hash after a deploy, or a rollback to an earlier one), so neither needs a
     * call. Idempotent and resumable; the work continues in the workpool by
     * cursor.
     */
    rebuild(ctx: MutationCtx | ActionCtx): Promise<unknown>;
    /** Expansion chunks that gave up, derivations past `maxDepth`, and paths a full row refused, newest first. */
    listExpansionFailures(ctx: QueryCtx | ActionCtx, options?: {
        limit?: number;
    }): Promise<{
        _id: string;
        reason: "failed" | "canceled" | "depth" | "paths";
        error: string;
        attempts: number;
        createdAt: number;
        cursor: unknown;
    }[]>;
    /** Re-enqueue a recorded failure's cursor unchanged. */
    resumeExpansion(ctx: MutationCtx | ActionCtx, failureId: string): Promise<unknown>;
}
export {};
//# sourceMappingURL=index.d.ts.map