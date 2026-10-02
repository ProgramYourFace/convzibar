import { CONFIG_UNREGISTERED_MARKER } from "../../component/config";
import { fnv1a, parseSchemaToGraphConfig } from "../../component/helpers";
import { ListDirectQueryBuilder } from "../list-direct/builder";
import { ListQueryBuilder } from "../list/builder";
import { evaluateManyPermissions, planSet } from "./traversal";
import { validateProperties, validateRelationParameter } from "./validation";
// ---------------------------------------------------------------------------
// Stable content hash of the compiled config — lets mutations ship a short
// hash instead of the full rule set (the component stores config by hash).
// ---------------------------------------------------------------------------
function stableStringify(v) {
    if (v === null || typeof v !== "object")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return "[" + v.map(stableStringify).join(",") + "]";
    const keys = Object.keys(v).sort();
    return ("{" +
        keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") +
        "}");
}
function hashGraphConfig(config) {
    const s = stableStringify(config);
    // Two FNV-1a passes with different offset bases → 64-bit-ish identity.
    return "cfg_" + fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x01000193);
}
/** Whether an error from a component mutation is the unregistered-config throw. */
function isConfigUnregisteredError(error) {
    return (error instanceof Error && error.message.includes(CONFIG_UNREGISTERED_MARKER));
}
/**
 * Create a new Zbar client instance.
 */
export function createZbar(component, options) {
    return new Zbar(component, options);
}
export class Zbar {
    component;
    options;
    _internal;
    /** Whether this instance has registered its config with the component yet. */
    _configRegistered = false;
    constructor(component, options) {
        this.component = component;
        this.options = options;
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
    async hasRelationship(ctx, subject, relation, object) {
        return planSet(this._internal, object.type, relation).check(ctx, subject, object);
    }
    async can(ctx, subject, permission, object) {
        return planSet(this._internal, object.type, permission).check(ctx, subject, object);
    }
    /**
     * Every permission the subject holds on the object, in declaration order:
     * one batched read of every permission's materialised members, then each
     * distinct remaining branch at most once.
     */
    async getPermissions(ctx, subject, object) {
        const z = this._internal;
        // Declaration order comes from the schema; the compiled config sorts its keys.
        const sets = z.graphConfig.sets[object.type] ?? {};
        const permissions = Object.keys(z.schema.entities[object.type]?.permissions ?? {}).filter((name) => sets[name] && !sets[name].writable);
        if (permissions.length === 0)
            return [];
        const granted = await evaluateManyPermissions(z, ctx, subject, object, permissions);
        return granted;
    }
    /** Fluent query builder for listing objects or subjects. */
    list() {
        return new ListQueryBuilder(this._internal);
    }
    /** Fluent query builder for listing **direct** (base) relationships. */
    listDirect() {
        return new ListDirectQueryBuilder(this._internal);
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
    async _runWrite(ctx, mutationRef, payload) {
        const z = this._internal;
        const attempt = (withConfig) => ctx.runMutation(mutationRef, {
            ...payload,
            configHash: z.configHash,
            graphConfig: withConfig ? z.graphConfig : undefined,
        });
        let result;
        if (!this._configRegistered) {
            result = await attempt(true);
        }
        else {
            try {
                result = await attempt(false);
            }
            catch (error) {
                if (!isConfigUnregisteredError(error))
                    throw error;
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
    async addRelation(ctx, subject, relation, object, options) {
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
    async setRelation(ctx, subject, relation, object, options) {
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
    async removeRelation(ctx, subject, relation, object) {
        const z = this._internal;
        validateRelationParameter(z, subject, relation, object);
        return this._runWrite(ctx, this.component.mutations.removeRelation, {
            subject,
            relation,
            object,
        });
    }
    /** Delete an entity and all its associated relationships. */
    async deleteEntity(ctx, entity) {
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
    async rebuild(ctx) {
        return this._runWrite(ctx, this.component.mutations.rebuild, {});
    }
    /** Expansion chunks that gave up, derivations past `maxDepth`, and paths a full row refused, newest first. */
    async listExpansionFailures(ctx, options) {
        return ctx.runQuery(this.component.queries.listExpansionFailures, {
            limit: options?.limit,
        });
    }
    /** Re-enqueue a recorded failure's cursor unchanged. */
    async resumeExpansion(ctx, failureId) {
        return ctx.runMutation(this.component.mutations.resumeExpansion, {
            failureId,
        });
    }
}
//# sourceMappingURL=index.js.map