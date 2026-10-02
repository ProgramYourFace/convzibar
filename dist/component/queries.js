import { v } from "convex/values";
import { buildScopeKey, typeRange } from "../shared/keys";
import { query } from "./_generated/server";
import { objectValidator, subjectValidator } from "./validators";
/** The most documents one index range of a read may return (CONTRACT §3). */
const RANGE_LIMIT = 8192;
/**
 * Read one index range, refusing (never truncating) a range over
 * `RANGE_LIMIT` documents: an answer cut at a limit would be wrong silently.
 */
async function bounded(query, what) {
    const rows = await query.take(RANGE_LIMIT + 1);
    if (rows.length > RANGE_LIMIT) {
        throw new Error(`convzibar: ${what} is a range over more than ${RANGE_LIMIT} rows; narrow the query.`);
    }
    return rows;
}
const factRowValidator = v.object({
    subjectType: v.string(),
    subjectId: v.string(),
    relation: v.string(),
    objectType: v.string(),
    objectId: v.string(),
    properties: v.optional(v.any()),
});
// ---------------------------------------------------------------------------
// effectiveRelationships
// ---------------------------------------------------------------------------
async function fetchEffective(ctx, index, anchors, relations, points, range) {
    if (anchors.length === 0 || relations.length === 0)
        return [];
    const forward = index === "by_subject_relation_object";
    const anchorField = forward ? "subjectKey" : "objectKey";
    const farField = forward ? "objectKey" : "subjectKey";
    const reads = anchors.flatMap((anchor) => {
        const key = buildScopeKey(anchor.type, anchor.id);
        return relations.flatMap((rel) => {
            if (points) {
                // A point is always read through the forward index; both indexes hold
                // the same (subject, relation, object) triple.
                return points.map((far) => ctx.db
                    .query("effectiveRelationships")
                    .withIndex("by_subject_relation_object", (q) => forward
                    ? q
                        .eq("subjectKey", key)
                        .eq("relation", rel)
                        .eq("objectKey", far)
                    : q
                        .eq("subjectKey", far)
                        .eq("relation", rel)
                        .eq("objectKey", key))
                    .unique());
            }
            if (range !== undefined) {
                const { lower, upper } = typeRange(range);
                return [
                    bounded(ctx.db
                        .query("effectiveRelationships")
                        .withIndex(index, (q) => q
                        .eq(anchorField, key)
                        .eq("relation", rel)
                        .gte(farField, lower)
                        .lt(farField, upper)), `(${key}, ${rel}, ${range}:*)`),
                ];
            }
            return [];
        });
    });
    return (await Promise.all(reads)).flat().filter((r) => r !== null);
}
/** Rows `(subject, relation ∈ relations, object)`; the object side is points (scope keys) or a type range. */
export const effectiveForward = query({
    args: {
        subjects: v.array(subjectValidator),
        relations: v.array(v.string()),
        objectPoints: v.optional(v.array(v.string())),
        objectRange: v.optional(v.string()), // objectType
    },
    returns: v.array(v.any()), // effectiveRelationships documents
    handler: async (ctx, args) => fetchEffective(ctx, "by_subject_relation_object", args.subjects, args.relations, args.objectPoints, args.objectRange),
});
/** Rows `(subject, relation ∈ relations, object)`; the subject side is points (scope keys) or a type range. */
export const effectiveReverse = query({
    args: {
        objects: v.array(objectValidator),
        relations: v.array(v.string()),
        subjectPoints: v.optional(v.array(v.string())),
        subjectRange: v.optional(v.string()), // subjectType
    },
    returns: v.array(v.any()), // effectiveRelationships documents
    handler: async (ctx, args) => fetchEffective(ctx, "by_object_relation_subject", args.objects, args.relations, args.subjectPoints, args.subjectRange),
});
// ---------------------------------------------------------------------------
// relationships (facts)
// ---------------------------------------------------------------------------
function factRow(r) {
    return {
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        relation: r.relation,
        objectType: r.objectType,
        objectId: r.objectId,
        properties: r.properties,
    };
}
/**
 * Facts read from one end. `forward`: anchors are fact subjects, read through
 * `by_subject_relation_object`; otherwise anchors are fact objects, read
 * through `by_object_relation_subject`. The far side is either exact points,
 * a type range, or (neither) the whole `(anchor, relation)` prefix.
 */
async function fetchFacts(ctx, forward, anchors, relations, points, range) {
    if (anchors.length === 0 || relations.length === 0)
        return [];
    const index = forward
        ? "by_subject_relation_object"
        : "by_object_relation_subject";
    const [aType, aId, fType, fId] = forward
        ? ["subjectType", "subjectId", "objectType", "objectId"]
        : ["objectType", "objectId", "subjectType", "subjectId"];
    const reads = anchors.flatMap((anchor) => relations.flatMap((rel) => {
        const prefix = (q) => q.eq(aType, anchor.type).eq(aId, anchor.id).eq("relation", rel);
        if (points) {
            return points.map((p) => ctx.db
                .query("relationships")
                .withIndex(index, (q) => prefix(q).eq(fType, p.type).eq(fId, p.id))
                .take(1));
        }
        return [
            bounded(ctx.db
                .query("relationships")
                .withIndex(index, (q) => range !== undefined ? prefix(q).eq(fType, range) : prefix(q)), `facts (${anchor.type}:${anchor.id}, ${rel}, ${range ?? "*"})`),
        ];
    }));
    return (await Promise.all(reads)).flat().map(factRow);
}
/** Facts `(subject ∈ subjects, relation ∈ relations, object)`, object side as points or a type range. */
export const factsForward = query({
    args: {
        subjects: v.array(subjectValidator),
        relations: v.array(v.string()),
        objectRange: v.optional(v.string()), // objectType
        objectPoints: v.optional(v.array(objectValidator)),
    },
    returns: v.array(factRowValidator),
    handler: async (ctx, args) => fetchFacts(ctx, true, args.subjects, args.relations, args.objectPoints, args.objectRange),
});
/** Facts `(subject, relation ∈ relations, object ∈ objects)`, subject side as points or a type range. */
export const factsReverse = query({
    args: {
        objects: v.array(objectValidator),
        relations: v.array(v.string()),
        subjectRange: v.optional(v.string()), // subjectType
        subjectPoints: v.optional(v.array(subjectValidator)),
    },
    returns: v.array(factRowValidator),
    handler: async (ctx, args) => fetchFacts(ctx, false, args.objects, args.relations, args.subjectPoints, args.subjectRange),
});
/**
 * Facts with their properties, for `listDirect()`. Anchored on the subject, the
 * object, or both. With a relation list every read is one exact range per
 * relation (the far-side type joins the prefix when given); without one the
 * anchor's whole prefix is read and type filters apply in memory.
 */
export const listDirectRelationships = query({
    args: {
        subject: v.optional(subjectValidator),
        object: v.optional(objectValidator),
        relations: v.optional(v.array(v.string())),
        filterSubjectType: v.optional(v.string()),
        filterObjectType: v.optional(v.string()),
    },
    returns: v.array(v.object({
        _id: v.string(),
        _creationTime: v.number(),
        ...factRowValidator.fields,
    })),
    handler: async (ctx, args) => {
        const { subject, object, filterSubjectType, filterObjectType } = args;
        const relations = args.relations && args.relations.length > 0 ? args.relations : undefined;
        let rows;
        if (subject) {
            // Subject-anchored (and, with an object, a point per relation).
            const farPoint = object ? [object] : undefined;
            if (relations) {
                const reads = relations.map((rel) => bounded(ctx.db
                    .query("relationships")
                    .withIndex("by_subject_relation_object", (q) => {
                    let c = q
                        .eq("subjectType", subject.type)
                        .eq("subjectId", subject.id)
                        .eq("relation", rel);
                    if (farPoint)
                        c = c.eq("objectType", object.type).eq("objectId", object.id);
                    else if (filterObjectType)
                        c = c.eq("objectType", filterObjectType);
                    return c;
                }), `facts (${subject.type}:${subject.id}, ${rel}, *)`));
                rows = (await Promise.all(reads)).flat();
            }
            else {
                rows = await bounded(ctx.db
                    .query("relationships")
                    .withIndex("by_subject_relation_object", (q) => q.eq("subjectType", subject.type).eq("subjectId", subject.id)), `facts (${subject.type}:${subject.id}, *, *)`);
                if (object) {
                    rows = rows.filter((r) => r.objectType === object.type && r.objectId === object.id);
                }
                else if (filterObjectType) {
                    rows = rows.filter((r) => r.objectType === filterObjectType);
                }
            }
        }
        else if (object) {
            if (relations) {
                const reads = relations.map((rel) => bounded(ctx.db
                    .query("relationships")
                    .withIndex("by_object_relation_subject", (q) => {
                    const c = q
                        .eq("objectType", object.type)
                        .eq("objectId", object.id)
                        .eq("relation", rel);
                    return filterSubjectType
                        ? c.eq("subjectType", filterSubjectType)
                        : c;
                }), `facts (*, ${rel}, ${object.type}:${object.id})`));
                rows = (await Promise.all(reads)).flat();
            }
            else {
                rows = await bounded(ctx.db
                    .query("relationships")
                    .withIndex("by_object_relation_subject", (q) => q.eq("objectType", object.type).eq("objectId", object.id)), `facts (*, *, ${object.type}:${object.id})`);
                if (filterSubjectType)
                    rows = rows.filter((r) => r.subjectType === filterSubjectType);
            }
        }
        else {
            return [];
        }
        return rows.map((r) => ({
            _id: r._id,
            _creationTime: r._creationTime,
            ...factRow(r),
        }));
    },
});
// ---------------------------------------------------------------------------
// expansionFailures (CONTRACT.md §5.7)
// ---------------------------------------------------------------------------
/** The most recent expansion failures, newest first. Bounded by `limit` (default 100). */
export const listExpansionFailures = query({
    args: { limit: v.optional(v.number()) },
    returns: v.array(v.object({
        _id: v.string(),
        reason: v.string(),
        error: v.string(),
        attempts: v.number(),
        createdAt: v.number(),
        cursor: v.any(),
    })),
    handler: async (ctx, args) => {
        const rows = await ctx.db
            .query("expansionFailures")
            .withIndex("by_createdAt")
            .order("desc")
            .take(Math.max(1, Math.min(args.limit ?? 100, 1000)));
        return rows.map((r) => ({
            _id: r._id,
            reason: r.reason,
            error: r.error,
            attempts: r.attempts,
            createdAt: r.createdAt,
            cursor: r.cursor,
        }));
    },
});
//# sourceMappingURL=queries.js.map