import { CONFIG_UNREGISTERED_MARKER } from "../../component/config";
import { fnv1a, parseSchemaToGraphConfig } from "../../component/helpers";
import type { GraphConfig } from "../../component/types";
import type {
  ZbarInternal,
  ActionCtx,
  MutationCtx,
  QueryCtx,
} from "../internal";
import type {
  EntityPermissions,
  EntityRelations,
  ResolvedProperties,
  ZbarSchema,
} from "../types";
import { ListDirectQueryBuilder } from "../list-direct/builder";
import type { ListDirectInitial } from "../list-direct/types";
import { ListQueryBuilder } from "../list/builder";
import type { ListInitial } from "../list/types";
import { evaluateManyPermissions, planSet } from "./traversal";
import { validateProperties, validateRelationParameter } from "./validation";

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

// ---------------------------------------------------------------------------
// Stable content hash of the compiled config — lets mutations ship a short
// hash instead of the full rule set (the component stores config by hash).
// ---------------------------------------------------------------------------

function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") +
    "}"
  );
}

function hashGraphConfig(config: GraphConfig): string {
  const s = stableStringify(config);
  // Two FNV-1a passes with different offset bases → 64-bit-ish identity.
  return "cfg_" + fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x01000193);
}

/** Whether an error from a component mutation is the unregistered-config throw. */
function isConfigUnregisteredError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes(CONFIG_UNREGISTERED_MARKER)
  );
}

/**
 * Create a new Zbar client instance.
 */
export function createZbar<Schema extends ZbarSchema>(
  component: any,
  options: ZbarOptions<Schema>,
) {
  return new Zbar<Schema>(component, options);
}

export class Zbar<Schema extends ZbarSchema> {
  private _internal: ZbarInternal;
  /** Whether this instance has registered its config with the component yet. */
  private _configRegistered = false;

  constructor(
    public component: any,
    private options: ZbarOptions<Schema>,
  ) {
    // The limits are part of the config the component stores and the BFS
    // obeys, so they are compiled in (and hashed).
    const graphConfig = parseSchemaToGraphConfig(options.schema, {
      maxDepth: options.maxDepth,
      writeBudget: options.writeBudget,
    });
    this._internal = {
      component,
      schema: options.schema,
      graphConfig,
      configHash: hashGraphConfig(graphConfig),
    };
  }

  /**
   * The compiled graph configuration. Exposed for advanced use cases and a
   * handful of tests that inspect it or set `mockWorkpool`.
   */
  get graphConfig() {
    return this._internal.graphConfig;
  }

  /** Stable content hash of the compiled config (mutations ship this). */
  get configHash() {
    return this._internal.configHash;
  }

  /**
   * Determine if a subject has a specific relationship with an object.
   */
  async hasRelationship<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    object: { type: ObjectType; id: string },
  ): Promise<boolean> {
    return planSet(this._internal, object.type, relation).check(
      ctx,
      subject,
      object,
    );
  }

  async can<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    permission: Permission,
    object: { type: ObjectType; id: string },
  ): Promise<boolean> {
    return planSet(this._internal, object.type, permission).check(
      ctx,
      subject,
      object,
    );
  }

  /**
   * Every permission the subject holds on the object, in declaration order:
   * one batched read of every permission's materialised members, then each
   * distinct remaining branch at most once.
   */
  async getPermissions<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    object: { type: ObjectType; id: string },
  ): Promise<EntityPermissions<Schema, ObjectType>[]> {
    const z = this._internal;
    // Declaration order comes from the schema; the compiled config sorts its keys.
    const sets = z.graphConfig.sets[object.type] ?? {};
    const permissions = Object.keys(
      z.schema.entities[object.type]?.permissions ?? {},
    ).filter((name) => sets[name] && !sets[name].writable);
    if (permissions.length === 0) return [];
    const granted = await evaluateManyPermissions(
      z,
      ctx,
      subject,
      object,
      permissions,
    );
    return granted as EntityPermissions<Schema, ObjectType>[];
  }

  /** Fluent query builder for listing objects or subjects. */
  list(): ListInitial<Schema> {
    return new ListQueryBuilder(this._internal) as any;
  }

  /** Fluent query builder for listing **direct** (base) relationships. */
  listDirect(): ListDirectInitial<Schema> {
    return new ListDirectQueryBuilder(this._internal) as any;
  }

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
  private async _runWrite(
    ctx: MutationCtx | ActionCtx,
    mutationRef: any,
    payload: Record<string, unknown>,
  ): Promise<any> {
    const z = this._internal;
    const attempt = (withConfig: boolean) =>
      ctx.runMutation(mutationRef, {
        ...payload,
        configHash: z.configHash,
        graphConfig: withConfig ? z.graphConfig : undefined,
      });

    let result;
    if (!this._configRegistered) {
      result = await attempt(true);
    } else {
      try {
        result = await attempt(false);
      } catch (error) {
        if (!isConfigUnregisteredError(error)) throw error;
        result = await attempt(true);
      }
    }
    this._configRegistered = true;
    return result;
  }

  /**
   * Add a relationship between a subject and an object. If the relation has
   * schema-defined properties, pass them via `options.properties`.
   */
  async addRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: MutationCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    object: { type: ObjectType; id: string },
    options?: {
      properties?: ResolvedProperties<
        Schema,
        ObjectType,
        Relation & string
      > extends undefined
        ? never
        : ResolvedProperties<Schema, ObjectType, Relation & string>;
    },
  ): Promise<string> {
    const z = this._internal;
    validateRelationParameter(z, subject, relation, object);
    if (options?.properties !== undefined) {
      validateProperties(z, object.type, relation, options.properties);
    }

    return this._runWrite(ctx, this.component.mutations.addRelation, {
      subject,
      relation,
      object,
      properties: options?.properties,
    });
  }

  /**
   * Add a relationship, clearing any existing relationships between the
   * subject and object atomically.
   */
  async setRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: MutationCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    object: { type: ObjectType; id: string },
    options?: {
      properties?: ResolvedProperties<
        Schema,
        ObjectType,
        Relation & string
      > extends undefined
        ? never
        : ResolvedProperties<Schema, ObjectType, Relation & string>;
    },
  ): Promise<string> {
    const z = this._internal;
    validateRelationParameter(z, subject, relation, object);
    if (options?.properties !== undefined) {
      validateProperties(z, object.type, relation, options.properties);
    }

    const objectRelations = Object.values(z.graphConfig.sets[object.type] ?? {})
      .filter((set) => set.writable)
      .map((set) => set.name);

    return this._runWrite(ctx, this.component.mutations.setRelation, {
      subject,
      relation,
      object,
      objectRelations,
      properties: options?.properties,
    });
  }

  /** Remove a relationship between a subject and an object. */
  async removeRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: MutationCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    object: { type: ObjectType; id: string },
  ): Promise<boolean> {
    const z = this._internal;
    validateRelationParameter(z, subject, relation, object);

    return this._runWrite(ctx, this.component.mutations.removeRelation, {
      subject,
      relation,
      object,
    });
  }

  /** Delete an entity and all its associated relationships. */
  async deleteEntity<EntityType extends keyof Schema["entities"] & string>(
    ctx: MutationCtx | ActionCtx,
    entity: { type: EntityType; id: string },
  ): Promise<{
    relationshipsRemoved: number;
    effectiveRelationshipsRemoved: number;
  }> {
    return this._runWrite(ctx, this.component.mutations.deleteEntity, {
      entity,
    });
  }

  // -------------------------------------------------------------------------
  // Materialization maintenance (CONTRACT.md §5.6–5.7).
  // -------------------------------------------------------------------------

  /**
   * Re-derive every materialized row under this instance's config, then
   * retire every path it does not justify (CONTRACT §5.6). The component also
   * enqueues this itself whenever a write changes the active config (a new
   * hash after a deploy, or a rollback to an earlier one), so neither needs a
   * call. Idempotent and resumable; the work continues in the workpool by
   * cursor.
   */
  async rebuild(ctx: MutationCtx | ActionCtx): Promise<unknown> {
    return this._runWrite(ctx, this.component.mutations.rebuild, {});
  }

  /** Expansion chunks that gave up, derivations past `maxDepth`, and paths a full row refused, newest first. */
  async listExpansionFailures(
    ctx: QueryCtx | ActionCtx,
    options?: { limit?: number },
  ): Promise<
    {
      _id: string;
      reason: "failed" | "canceled" | "depth" | "paths";
      error: string;
      attempts: number;
      createdAt: number;
      cursor: unknown;
    }[]
  > {
    return ctx.runQuery(this.component.queries.listExpansionFailures, {
      limit: options?.limit,
    });
  }

  /** Re-enqueue a recorded failure's cursor unchanged. */
  async resumeExpansion(
    ctx: MutationCtx | ActionCtx,
    failureId: string,
  ): Promise<unknown> {
    return ctx.runMutation(this.component.mutations.resumeExpansion, {
      failureId,
    });
  }
}
