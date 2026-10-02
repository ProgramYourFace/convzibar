/**
 * Write entry points of the engine (EXPANSION.md §2.9). Every public mutation
 * loads the config (registering it on first use) and makes it the active
 * config (`envOf`; a change owes a `rebuild`), runs the seed in the caller's
 * transaction (`insertFact` / `deleteFact` in expand.ts), and hands its items
 * to `execute`, which runs what fits the budget, depth-first; what is left is
 * enqueued as ONE continuation on `expansionPool` (`executeAndContinue`).
 */
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, } from "./_generated/server";
import { activateConfig, activeConfigHash, ensureConfig, limitsOf, loadConfig, } from "./config";
import { deleteFact, execute, findFact, insertFact, parseCursor, } from "./expand";
import { objectValidator, propertiesValidator, subjectValidator, } from "./validators";
import { expansionPool } from "./workpool";
/** Attempts of one cursor before it is recorded in `expansionFailures` (CONTRACT §5.7). */
export const MAX_ATTEMPTS = 5;
// The config arg shape shared by every public write: the content hash always,
// the full compiled config on the client's first use of that hash.
const configArgs = { configHash: v.string(), graphConfig: v.optional(v.any()) };
const REBUILD = { kind: "rebuild", phase: "derive", after: null };
// ---------------------------------------------------------------------------
// Continuations.
// ---------------------------------------------------------------------------
/** Enqueue `cursor` (nothing when it has no item); `mock` parks it instead (test-time driver). */
async function enqueueCursor(ctx, cursor, mock) {
    if (cursor.items.length === 0)
        return;
    if (mock) {
        // Test-time escape hatch: park the cursor; the test decides when it runs.
        await ctx.db.insert("mockWorkpool", {
            mutationName: "continueExpansion",
            args: cursor,
        });
        return;
    }
    await expansionPool.enqueueMutation(ctx, internal.mutations.continueExpansion, cursor, {
        onComplete: internal.mutations.chunkCompleted,
        context: cursor,
    });
}
/**
 * The environment of a transaction. `config` null is config-free work: a
 * removal started by maintenance (CONTRACT §5.5 reads no rule), on the real
 * workpool, with the default budget.
 */
export function envFor(config, configHash, budget) {
    return { config, configHash, budget: budget ?? limitsOf(config).writeBudget };
}
/**
 * Run `items` in this transaction (`execute`), then enqueue what is left,
 * followed by `owed` (work this transaction owes but does not start), as at
 * most ONE continuation with a fresh budget (CONTRACT §5.3, I5).
 */
export async function executeAndContinue(ctx, env, items, owed = []) {
    const { rest, stats } = await execute(ctx, env, items);
    await enqueueCursor(ctx, {
        items: [...rest, ...owed],
        configHash: env.configHash,
        budget: limitsOf(env.config).writeBudget,
        attempts: 0,
    }, env.config?.mockWorkpool === true);
    return stats;
}
/**
 * Load the caller's config, registering it on first use, and make it the
 * active config (EXPANSION.md §2.9). When that changes the active hash (a
 * deploy, or a rollback to an earlier config), a `rebuild` under it is owed,
 * enqueued in the same transaction behind the write's own leftovers, so the
 * table is repaired without an operator and cursors of the previous config
 * become stale (Lemma Q).
 */
async function envOf(ctx, args) {
    const supplied = args.graphConfig;
    if (supplied !== undefined)
        await ensureConfig(ctx, args.configHash, supplied);
    const config = supplied ?? (await loadConfig(ctx, args.configHash));
    const env = envFor(config, args.configHash);
    const owed = (await activateConfig(ctx, args.configHash))
        ? [REBUILD]
        : [];
    return { env, owed };
}
/**
 * The cursor `payload` names, as this transaction may run it (EXPANSION.md
 * §2.9): read by `parseCursor` (an unrecognized item is dropped), then, when
 * its `configHash` is not the active hash, its add and rebuild items are
 * dropped as stale (Lemma Q: nothing is owed to them); its removal items read
 * no rule and are never stale. Null: nothing to run.
 */
async function liveCursor(ctx, payload) {
    const cursor = parseCursor(payload);
    if (cursor === null) {
        console.warn("Zbar: dropped a continuation payload of an unrecognized shape; run rebuild.");
        return null;
    }
    let { items } = cursor;
    if (cursor.configHash !== null) {
        const active = await activeConfigHash(ctx);
        if (active !== null && active !== cursor.configHash) {
            items = items.filter((i) => i.kind === "remove" || i.kind === "deleteEntity");
            if (items.length < cursor.items.length) {
                console.debug(`Zbar: dropped ${cursor.items.length - items.length} item(s) of inactive config '${cursor.configHash}'.`);
            }
        }
    }
    return items.length === 0 ? null : { ...cursor, items };
}
/** One chunk: run the cursor's items under its budget (CONTRACT §5.3); enqueue at most one continuation. */
export const continueExpansion = internalMutation({
    // Validated inside (`liveCursor`): a payload of a previous engine version
    // must not fail at the boundary, where nothing would record it.
    args: v.any(),
    returns: v.null(),
    handler: async (ctx, payload) => {
        const cursor = await liveCursor(ctx, payload);
        if (!cursor)
            return null;
        const config = cursor.configHash === null
            ? null
            : await loadConfig(ctx, cursor.configHash);
        await executeAndContinue(ctx, envFor(config, cursor.configHash, cursor.budget), cursor.items);
        return null;
    },
});
/**
 * Workpool `onComplete` of every chunk (P4). A failed or canceled chunk wrote
 * nothing; re-enqueue the same cursor (the same list) with half the budget,
 * and after `MAX_ATTEMPTS` record it. Stale items are dropped instead (Lemma
 * Q). Reads its arguments, the active hash and the workpool's own state,
 * never the data its chunk read, so it cannot fail for the reason its chunk
 * did.
 */
export const chunkCompleted = internalMutation({
    args: vOnCompleteArgs(v.any()),
    returns: v.null(),
    handler: async (ctx, { context, result }) => {
        if (result.kind === "success")
            return null;
        const cursor = await liveCursor(ctx, context);
        if (!cursor)
            return null;
        const attempts = cursor.attempts + 1;
        const error = result.kind === "failed" ? result.error : "canceled";
        if (attempts < MAX_ATTEMPTS) {
            await enqueueCursor(ctx, {
                ...cursor,
                budget: Math.max(1, Math.floor(cursor.budget / 2)),
                attempts,
            }, false);
            return null;
        }
        await ctx.db.insert("expansionFailures", {
            cursor: { ...cursor, attempts },
            reason: result.kind,
            error,
            attempts,
            createdAt: Date.now(),
        });
        console.error(`Zbar: expansion chunk ${result.kind} ${attempts} times (${error}); recorded in expansionFailures. ` +
            `Resume it with resumeExpansion once the cause is fixed.`);
        return null;
    },
});
/**
 * Delete the record and re-enqueue its cursor: the same items and hash, the
 * budget reset to the config's `writeBudget` and `attempts` to 0. Stale items
 * are not re-enqueued (Lemma Q: nothing is owed to them).
 */
export const resumeExpansion = mutation({
    args: { failureId: v.id("expansionFailures") },
    returns: v.null(),
    handler: async (ctx, { failureId }) => {
        const failure = await ctx.db.get(failureId);
        if (!failure)
            throw new Error(`Zbar: expansion failure '${failureId}' not found.`);
        if (failure.reason === "depth" || failure.reason === "paths") {
            throw new Error(`Zbar: a '${failure.reason}' failure is not a continuation. ` +
                (failure.reason === "depth"
                    ? "Raise maxDepth, then run rebuild."
                    : "Run rebuild."));
        }
        await ctx.db.delete(failureId);
        const cursor = await liveCursor(ctx, failure.cursor);
        if (!cursor)
            return null;
        const config = cursor.configHash === null
            ? null
            : await loadConfig(ctx, cursor.configHash);
        await enqueueCursor(ctx, { ...cursor, budget: limitsOf(config).writeBudget, attempts: 0 }, config?.mockWorkpool === true);
        return null;
    },
});
// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------
export const addRelation = mutation({
    args: {
        subject: subjectValidator,
        relation: v.string(),
        object: objectValidator,
        properties: propertiesValidator,
        ...configArgs,
    },
    returns: v.id("relationships"),
    handler: async (ctx, args) => {
        const { env, owed } = await envOf(ctx, args);
        const { id, items } = await insertFact(ctx, env, args);
        await executeAndContinue(ctx, env, items, owed);
        return id;
    },
});
export const removeRelation = mutation({
    args: {
        subject: subjectValidator,
        relation: v.string(),
        object: objectValidator,
        ...configArgs,
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
        const { env, owed } = await envOf(ctx, args);
        const fact = await findFact(ctx, args.subject, args.relation, args.object);
        const items = fact ? (await deleteFact(ctx, fact)).items : [];
        await executeAndContinue(ctx, env, items, owed);
        return fact !== null;
    },
});
/**
 * Replace every other relation in `objectRelations` that the subject holds on
 * the object with `relation`, in one transaction. The add items run before
 * the removal items (EXPANSION.md §2.9: a row both facts derive gains its new
 * path before it loses the old one, so it never disappears).
 */
export const setRelation = mutation({
    args: {
        subject: subjectValidator,
        relation: v.string(),
        object: objectValidator,
        objectRelations: v.array(v.string()),
        properties: propertiesValidator,
        ...configArgs,
    },
    returns: v.id("relationships"),
    handler: async (ctx, args) => {
        const { env, owed } = await envOf(ctx, args);
        const added = await insertFact(ctx, env, args);
        const removals = [];
        for (const other of new Set(args.objectRelations)) {
            if (other === args.relation)
                continue;
            const fact = await findFact(ctx, args.subject, other, args.object);
            if (fact)
                removals.push(...(await deleteFact(ctx, fact)).items);
        }
        await executeAndContinue(ctx, env, [...added.items, ...removals], owed);
        return added.id;
    },
});
/**
 * Remove every fact that touches the entity, through the same removal path,
 * by cursor. The counts cover what this transaction did.
 */
export const deleteEntity = mutation({
    args: { entity: subjectValidator, ...configArgs },
    returns: v.object({
        relationshipsRemoved: v.number(),
        effectiveRelationshipsRemoved: v.number(),
    }),
    handler: async (ctx, args) => {
        const { env, owed } = await envOf(ctx, args);
        const stats = await executeAndContinue(ctx, env, [{ kind: "deleteEntity", entity: args.entity }], owed);
        return {
            relationshipsRemoved: stats.factsDeleted,
            effectiveRelationshipsRemoved: stats.rowsDeleted,
        };
    },
});
/**
 * CONTRACT §5.6: re-derive from every fact under this config (phase derive),
 * then retire every path this config does not justify (phase retire).
 * Continues itself in the workpool; idempotent and resumable. Also enqueued
 * automatically by any write that changes the active config (`envOf`).
 */
export const rebuild = mutation({
    args: configArgs,
    returns: v.null(),
    handler: async (ctx, args) => {
        const { env } = await envOf(ctx, args); // a rebuild owed by activation is this one
        await executeAndContinue(ctx, env, [REBUILD]);
        return null;
    },
});
// ---------------------------------------------------------------------------
// Test-only mock workpool helpers (the table exists only under NODE_ENV=test).
// ---------------------------------------------------------------------------
export const getMockWorkpool = internalQuery({
    args: {},
    returns: v.array(v.any()),
    handler: async (ctx) => await ctx.db.query("mockWorkpool").take(10_000),
});
export const deleteMockWorkpoolTask = internalMutation({
    args: { id: v.string() },
    returns: v.null(),
    handler: async (ctx, { id }) => {
        await ctx.db.delete(id);
        return null;
    },
});
//# sourceMappingURL=mutations.js.map