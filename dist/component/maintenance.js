import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { deleteFact, deleteRow, ensureMirror } from "./expand";
import { prefixRange } from "../shared/keys";
import { envFor, executeAndContinue } from "./mutations";
// ---------------------------------------------------------------------------
// Data maintenance: bounded, cursor-driven sweeps over the stored graph, for
// data migrations (the app's ledger steps in convex/migrateZbar.ts). Generic:
// nothing here knows an app relation name; the caller passes them.
//
// `deleteFactsByRelation` removes each fact through the engine's own
// `deleteFact` + removal (CONTRACT §5.5), which reads no rule, so it needs no
// config: every path naming the fact is found through `lineage`, whatever
// config wrote it. `deleteEffectiveRowsByKeyPrefix` deletes rows directly
// (with their lineage rows): it is for rows with no fact behind them.
// ---------------------------------------------------------------------------
const entityValidator = v.object({ type: v.string(), id: v.string() });
/**
 * One page of `relationships` in creation order, after the cursor. Components
 * cannot use `.paginate()` (a Convex restriction), so the cursor is the last
 * row's `_creationTime` as a string and a page is `take(numItems)` past it.
 */
async function factsPage(ctx, cursor, numItems) {
    const after = cursor === null || cursor === "" ? -Infinity : Number(cursor);
    const page = await ctx.db
        .query("relationships")
        .withIndex("by_creation_time", (q) => q.gt("_creationTime", after))
        .order("asc")
        .take(numItems);
    const last = page[page.length - 1];
    return {
        page,
        continueCursor: last ? String(last._creationTime) : (cursor ?? ""),
        isDone: page.length < numItems,
    };
}
/**
 * One page of the facts sweep, in creation order.
 *
 * A fact whose `relation` is in `relations`, or whose subject or object type is
 * in `entityTypes`, is removed through `deleteFact` (its mirror paths now,
 * every other path naming it by the removal cursor, continued in the
 * workpool). A v1 path that names it but has no lineage row is left for
 * `rebuild`, which retires paths naming missing facts.
 *
 * Every other fact gets its mirror normalised to the v2 shape
 * `{ baseIds: [factId], rule: 'fact' }` with its lineage row (inserted when
 * missing). Rows written before v2 carry no `rule`; without the tag,
 * `rebuild` would take a fact's own mirror for a retired path.
 *
 * Idempotent: a re-run of a page deletes nothing new and tags nothing new.
 */
export const deleteFactsByRelation = mutation({
    args: {
        relations: v.array(v.string()),
        entityTypes: v.optional(v.array(v.string())),
        cursor: v.union(v.string(), v.null()),
        numItems: v.number(),
    },
    returns: v.object({
        scanned: v.number(),
        deleted: v.number(),
        mirrorsTagged: v.number(),
        continueCursor: v.string(),
        isDone: v.boolean(),
    }),
    handler: async (ctx, args) => {
        const relations = new Set(args.relations);
        const entityTypes = new Set(args.entityTypes ?? []);
        const page = await factsPage(ctx, args.cursor, args.numItems);
        let deleted = 0;
        let mirrorsTagged = 0;
        const removals = [];
        for (const fact of page.page) {
            const retired = relations.has(fact.relation) ||
                entityTypes.has(fact.subjectType) ||
                entityTypes.has(fact.objectType);
            if (retired) {
                removals.push(...(await deleteFact(ctx, fact)).items);
                deleted++;
            }
            else if (await ensureMirror(ctx, fact)) {
                mirrorsTagged++;
            }
        }
        await executeAndContinue(ctx, envFor(null, null), removals);
        return {
            scanned: page.page.length,
            deleted,
            mirrorsTagged,
            continueCursor: page.continueCursor,
            isDone: page.isDone,
        };
    },
});
/**
 * Delete up to `numItems` effective rows whose subject key (or object key)
 * starts with `prefix` — e.g. `'user:'` for every row of an entity type the
 * schema dropped — with their lineage rows (Invariant L). Direct deletes, no
 * cascade (see the file header). Each call re-reads the range from its start
 * (deleted rows leave it), so it needs no cursor: `isDone` once a call finds
 * fewer than `numItems`.
 */
export const deleteEffectiveRowsByKeyPrefix = mutation({
    args: {
        prefix: v.string(),
        side: v.union(v.literal("subject"), v.literal("object")),
        numItems: v.number(),
    },
    returns: v.object({ deleted: v.number(), isDone: v.boolean() }),
    handler: async (ctx, { prefix, side, numItems }) => {
        if (prefix.length === 0)
            throw new Error("deleteEffectiveRowsByKeyPrefix: empty prefix");
        const { upper } = prefixRange(prefix);
        const rows = side === "subject"
            ? await ctx.db
                .query("effectiveRelationships")
                .withIndex("by_subject_relation_object", (q) => q.gte("subjectKey", prefix).lt("subjectKey", upper))
                .take(numItems)
            : await ctx.db
                .query("effectiveRelationships")
                .withIndex("by_object_relation_subject", (q) => q.gte("objectKey", prefix).lt("objectKey", upper))
                .take(numItems);
        for (const row of rows)
            await deleteRow(ctx, row);
        return { deleted: rows.length, isDone: rows.length < numItems };
    },
});
/**
 * One page of facts in creation order, keeping those whose relation is in
 * `relations`. For each kept fact, `siblings` lists which of `pairRelations`
 * the same (subject, object) pair also holds as facts — one exact index read
 * per (fact, relation). The caller decides what to do and removes through the
 * engine's removal path.
 */
export const pageFacts = query({
    args: {
        relations: v.array(v.string()),
        pairRelations: v.optional(v.array(v.string())),
        cursor: v.union(v.string(), v.null()),
        numItems: v.number(),
    },
    returns: v.object({
        facts: v.array(v.object({
            id: v.string(),
            subject: entityValidator,
            relation: v.string(),
            object: entityValidator,
            siblings: v.array(v.string()),
        })),
        continueCursor: v.string(),
        isDone: v.boolean(),
    }),
    handler: async (ctx, args) => {
        const relations = new Set(args.relations);
        const page = await factsPage(ctx, args.cursor, args.numItems);
        const facts = [];
        for (const fact of page.page) {
            if (!relations.has(fact.relation))
                continue;
            const siblings = [];
            for (const relation of args.pairRelations ?? []) {
                if (relation === fact.relation)
                    continue;
                const sibling = await ctx.db
                    .query("relationships")
                    .withIndex("by_subject_relation_object", (q) => q
                    .eq("subjectType", fact.subjectType)
                    .eq("subjectId", fact.subjectId)
                    .eq("relation", relation)
                    .eq("objectType", fact.objectType)
                    .eq("objectId", fact.objectId))
                    .first();
                if (sibling)
                    siblings.push(relation);
            }
            facts.push({
                id: fact._id,
                subject: { type: fact.subjectType, id: fact.subjectId },
                relation: fact.relation,
                object: { type: fact.objectType, id: fact.objectId },
                siblings,
            });
        }
        return { facts, continueCursor: page.continueCursor, isDone: page.isDone };
    },
});
//# sourceMappingURL=maintenance.js.map