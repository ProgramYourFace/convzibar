import { buildScopeKey } from "../../shared/keys";
import { structuralRelations } from "./structural";
function idOf(scopeKey) {
    return scopeKey.slice(scopeKey.indexOf(":") + 1);
}
async function readForward(z, ctx, table, subjects, relations, far) {
    if (subjects.length === 0 || relations.length === 0)
        return [];
    if (table === "facts") {
        const rows = await ctx.runQuery(z.component.queries.factsForward, {
            subjects: subjects.map(({ type, id }) => ({ type, id })),
            relations: [...relations],
            objectRange: far.ids ? undefined : far.type,
            objectPoints: far.ids?.map((id) => ({ type: far.type, id })),
        });
        return rows.map((r) => ({
            subjectId: r.subjectId,
            objectId: r.objectId,
            facts: 1,
            properties: r.properties,
        }));
    }
    const rows = await ctx.runQuery(z.component.queries.effectiveForward, {
        subjects: subjects.map(({ type, id }) => ({ type, id })),
        relations: [...relations],
        objectPoints: far.ids?.map((id) => buildScopeKey(far.type, id)),
        objectRange: far.ids ? undefined : far.type,
    });
    return rows.map(rowEdge);
}
async function readReverse(z, ctx, table, objects, relations, far) {
    if (objects.length === 0 || relations.length === 0)
        return [];
    if (table === "facts") {
        const rows = await ctx.runQuery(z.component.queries.factsReverse, {
            objects: objects.map(({ type, id }) => ({ type, id })),
            relations: [...relations],
            subjectRange: far.ids ? undefined : far.type,
            subjectPoints: far.ids?.map((id) => ({ type: far.type, id })),
        });
        return rows.map((r) => ({
            subjectId: r.subjectId,
            objectId: r.objectId,
            facts: 1,
            properties: r.properties,
        }));
    }
    const rows = await ctx.runQuery(z.component.queries.effectiveReverse, {
        objects: objects.map(({ type, id }) => ({ type, id })),
        relations: [...relations],
        subjectPoints: far.ids?.map((id) => buildScopeKey(far.type, id)),
        subjectRange: far.ids ? undefined : far.type,
    });
    return rows.map(rowEdge);
}
const rowEdge = (r) => ({
    subjectId: idOf(r.subjectKey),
    objectId: idOf(r.objectKey),
    facts: Math.min(...r.paths.map((p) => p.baseIds.length)),
});
/** Facts read from either end; exported for `listDirect`. */
export const readFactsForward = (z, ctx, subjects, relations, far) => readForward(z, ctx, "facts", subjects, relations, far);
export const readFactsReverse = (z, ctx, objects, relations, far) => readReverse(z, ctx, "facts", objects, relations, far);
const objectIdsOf = (rows) => new Set(rows.map((r) => r.objectId));
const subjectIdsOf = (rows) => new Set(rows.map((r) => r.subjectId));
function levelsBy(rows, side) {
    const out = new Map();
    for (const r of rows)
        out.set(r[side], Math.min(out.get(r[side]) ?? Infinity, r.facts));
    return out;
}
function minInto(into, from, plus = 0) {
    for (const [id, l] of from)
        into.set(id, Math.min(into.get(id) ?? Infinity, l + plus));
}
/** Every id at `facts`. */
const at = (ids, facts) => new Map([...ids].map((id) => [id, facts]));
/** The fewest facts per id over several answers. */
function minOf(maps, plus = 0) {
    const out = new Map();
    for (const m of maps)
        minInto(out, m, plus);
    return out;
}
const entities = (type, ids) => [...ids].map((id) => ({ type, id }));
function intersect(candidates, reachable) {
    const hits = new Set();
    for (const id of candidates)
        if (reachable.has(id))
            hits.add(id);
    return hits;
}
/**
 * Above this many point reads a batched check switches to one range read per
 * relation plus an in-memory intersection. Convex caps a transaction at 4,096
 * index reads; a point per (relation × candidate) exhausts that quickly.
 */
const MAX_POINT_LOOKUPS = 128;
// ---------------------------------------------------------------------------
// Leaf — `(subject, relation ∈ relations, object:objectType)` rows in one table.
// ---------------------------------------------------------------------------
/**
 * Existence and enumeration over one table. Typed: a leaf answers only for
 * objects of `objectType` (a relation name means something only on its own
 * type — CONTRACT §4.1), so any call for another type is empty.
 */
class Leaf {
    z;
    table;
    objectType;
    relations;
    cost = 1;
    constructor(z, table, objectType, relations) {
        this.z = z;
        this.table = table;
        this.objectType = objectType;
        this.relations = relations;
    }
    live(objectType) {
        return this.relations.length > 0 && objectType === this.objectType;
    }
    async check(ctx, subject, object) {
        if (!this.live(object.type))
            return false;
        const rows = await readForward(this.z, ctx, this.table, [subject], this.relations, {
            type: object.type,
            ids: [object.id],
        });
        return rows.length > 0;
    }
    async checkBatch(ctx, subject, objectType, candidateIds) {
        if (!this.live(objectType) || candidateIds.length === 0)
            return new Set();
        if (candidateIds.length * this.relations.length > MAX_POINT_LOOKUPS) {
            return intersect(candidateIds, await this.expandObjects(ctx, subject, objectType));
        }
        return objectIdsOf(await readForward(this.z, ctx, this.table, [subject], this.relations, {
            type: objectType,
            ids: candidateIds,
        }));
    }
    async checkBatchSubjects(ctx, object, subjectType, candidateIds) {
        if (!this.live(object.type) || candidateIds.length === 0)
            return new Set();
        if (candidateIds.length * this.relations.length > MAX_POINT_LOOKUPS) {
            return intersect(candidateIds, await this.expandSubjects(ctx, object, subjectType));
        }
        return subjectIdsOf(await readReverse(this.z, ctx, this.table, [object], this.relations, {
            type: subjectType,
            ids: candidateIds,
        }));
    }
    expandObjects(ctx, subject, objectType) {
        return this.expandObjectsFromMany(ctx, [subject], objectType);
    }
    expandSubjects(ctx, object, subjectType) {
        return this.expandSubjectsFromMany(ctx, [object], subjectType);
    }
    async expandObjectsFromMany(ctx, subjects, objectType) {
        if (!this.live(objectType) || subjects.length === 0)
            return new Set();
        return objectIdsOf(await readForward(this.z, ctx, this.table, subjects, this.relations, {
            type: objectType,
        }));
    }
    async expandSubjectsFromMany(ctx, objects, subjectType) {
        return new Set((await this.subjectLevels(ctx, objects, subjectType)).keys());
    }
    // The same three reads, each id with its fewest facts (a `Closure` base).
    async checkLevels(ctx, subject, objectType, ids) {
        if (!this.live(objectType) || ids.length === 0)
            return new Map();
        if (ids.length * this.relations.length > MAX_POINT_LOOKUPS) {
            const all = await this.objectLevels(ctx, [subject], objectType);
            return new Map(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)]));
        }
        const rows = await readForward(this.z, ctx, this.table, [subject], this.relations, { type: objectType, ids });
        return levelsBy(rows, "objectId");
    }
    async objectLevels(ctx, subjects, objectType) {
        if (!this.live(objectType) || subjects.length === 0)
            return new Map();
        return levelsBy(await readForward(this.z, ctx, this.table, subjects, this.relations, {
            type: objectType,
        }), "objectId");
    }
    async subjectLevels(ctx, objects, subjectType) {
        const typed = objects.filter((o) => o.type === this.objectType);
        if (this.relations.length === 0 || typed.length === 0)
            return new Map();
        return levelsBy(await readReverse(this.z, ctx, this.table, typed, this.relations, {
            type: subjectType,
        }), "subjectId");
    }
}
/** The set's own rows in `effectiveRelationships` (fact mirrors + materialized derivations). */
class Materialised extends Leaf {
    constructor(z, objectType, relations) {
        super(z, "effective", objectType, relations);
    }
}
// ---------------------------------------------------------------------------
// Inverse — `~T#r` on o: the nodes x:T with a fact (o, r, x).
// ---------------------------------------------------------------------------
/**
 * A facts leaf read backwards. The set's object o is the fact's SUBJECT and
 * the member x is the fact's OBJECT, so every method swaps ends. Typed on both
 * sides: members are `subjectType` only (another type with a relation of the
 * same name is a different relation).
 */
class Inverse {
    objectType;
    subjectType;
    relation;
    cost = 1;
    /** Facts `(x:objectType, relation, y:subjectType)`: the same edges, seen from the member. */
    facts;
    constructor(z, objectType, subjectType, relation) {
        this.objectType = objectType;
        this.subjectType = subjectType;
        this.relation = relation;
        this.facts = new Leaf(z, "facts", subjectType, [relation]);
    }
    ok(objectType, subjectType) {
        return objectType === this.objectType && subjectType === this.subjectType;
    }
    async check(ctx, subject, object) {
        if (!this.ok(object.type, subject.type))
            return false;
        return this.facts.check(ctx, object, subject);
    }
    async checkBatch(ctx, subject, objectType, ids) {
        if (!this.ok(objectType, subject.type))
            return new Set();
        return this.facts.checkBatchSubjects(ctx, subject, objectType, ids);
    }
    async checkBatchSubjects(ctx, object, subjectType, ids) {
        if (!this.ok(object.type, subjectType))
            return new Set();
        return this.facts.checkBatch(ctx, object, subjectType, ids);
    }
    expandObjects(ctx, subject, objectType) {
        return this.expandObjectsFromMany(ctx, [subject], objectType);
    }
    expandSubjects(ctx, object, subjectType) {
        return this.expandSubjectsFromMany(ctx, [object], subjectType);
    }
    async expandObjectsFromMany(ctx, subjects, objectType) {
        const typed = subjects.filter((s) => s.type === this.subjectType);
        if (objectType !== this.objectType || typed.length === 0)
            return new Set();
        return this.facts.expandSubjectsFromMany(ctx, typed, objectType);
    }
    async expandSubjectsFromMany(ctx, objects, subjectType) {
        const typed = objects.filter((o) => o.type === this.objectType);
        if (subjectType !== this.subjectType || typed.length === 0)
            return new Set();
        return this.facts.expandObjectsFromMany(ctx, typed, subjectType);
    }
    // One fact each.
    async checkLevels(ctx, subject, objectType, ids) {
        return at(await this.checkBatch(ctx, subject, objectType, ids), 1);
    }
    async objectLevels(ctx, subjects, objectType) {
        return at(await this.expandObjectsFromMany(ctx, subjects, objectType), 1);
    }
    async subjectLevels(ctx, objects, subjectType) {
        return at(await this.expandSubjectsFromMany(ctx, objects, subjectType), 1);
    }
}
// ---------------------------------------------------------------------------
// EdgeExpand — the first hop of a walks/expands arm. Reads FACTS only.
// ---------------------------------------------------------------------------
/**
 * Facts `(m:intermediateType, r ∈ relations, o:objectType)`. A derived row is
 * never a first hop (CONTRACT §2.1): that is what keeps a materialized arm and
 * the same arm computed equal.
 */
class EdgeExpand {
    z;
    objectType;
    intermediateType;
    relations;
    constructor(z, objectType, intermediateType, relations) {
        this.z = z;
        this.objectType = objectType;
        this.intermediateType = intermediateType;
        this.relations = relations;
    }
    /** Intermediates of every object in `objects`. */
    async listMany(ctx, objects) {
        const typed = objects.filter((o) => o.type === this.objectType);
        const rows = await readReverse(this.z, ctx, "facts", typed, this.relations, {
            type: this.intermediateType,
        });
        return entities(this.intermediateType, subjectIdsOf(rows));
    }
    /** Intermediates keyed by the object they hop from. */
    async listPairs(ctx, objects) {
        const typed = objects.filter((o) => o.type === this.objectType);
        const rows = await readReverse(this.z, ctx, "facts", typed, this.relations, {
            type: this.intermediateType,
        });
        const out = new Map();
        for (const r of rows) {
            const arr = out.get(r.objectId);
            if (arr)
                arr.push(r.subjectId);
            else
                out.set(r.objectId, [r.subjectId]);
        }
        return out;
    }
    /** Objects whose first hop contains any of `mids`. */
    async listObjects(ctx, mids) {
        if (mids.length === 0)
            return new Set();
        return objectIdsOf(await readForward(this.z, ctx, "facts", mids, this.relations, {
            type: this.objectType,
        }));
    }
}
// ---------------------------------------------------------------------------
// Compose — first hop (facts) then the full far set.
// ---------------------------------------------------------------------------
/**
 *   subject --second--> m:intermediateType --first hop (facts)--> object
 *
 * Small candidate sets are candidate-first (each candidate's intermediates,
 * then one batched check of the subject against them); large ones flip to
 * subject-first (the subject's reach, intersected).
 */
class Compose {
    firstHop;
    second;
    cost;
    constructor(firstHop, second) {
        this.firstHop = firstHop;
        this.second = second;
        this.cost = 1 + second.cost;
    }
    async check(ctx, subject, object) {
        return (await this.checkBatch(ctx, subject, object.type, [object.id])).has(object.id);
    }
    async checkBatch(ctx, subject, objectType, candidateIds) {
        if (candidateIds.length === 0 || objectType !== this.firstHop.objectType)
            return new Set();
        if (candidateIds.length * this.firstHop.relations.length >
            MAX_POINT_LOOKUPS) {
            return intersect(candidateIds, await this.expandObjects(ctx, subject, objectType));
        }
        const pairs = await this.firstHop.listPairs(ctx, entities(objectType, candidateIds));
        const midIds = new Set();
        for (const mids of pairs.values())
            for (const m of mids)
                midIds.add(m);
        if (midIds.size === 0)
            return new Set();
        const midHits = await this.second.checkBatch(ctx, subject, this.firstHop.intermediateType, [...midIds]);
        const hits = new Set();
        for (const [objectId, mids] of pairs)
            if (mids.some((m) => midHits.has(m)))
                hits.add(objectId);
        return hits;
    }
    async checkBatchSubjects(ctx, object, subjectType, candidateIds) {
        if (candidateIds.length === 0)
            return new Set();
        return intersect(candidateIds, await this.expandSubjects(ctx, object, subjectType));
    }
    expandObjects(ctx, subject, objectType) {
        return this.expandObjectsFromMany(ctx, [subject], objectType);
    }
    expandSubjects(ctx, object, subjectType) {
        return this.expandSubjectsFromMany(ctx, [object], subjectType);
    }
    async expandObjectsFromMany(ctx, subjects, objectType) {
        if (subjects.length === 0 || objectType !== this.firstHop.objectType)
            return new Set();
        const T = this.firstHop.intermediateType;
        const midIds = await this.second.expandObjectsFromMany(ctx, subjects, T);
        return this.firstHop.listObjects(ctx, entities(T, midIds));
    }
    async expandSubjectsFromMany(ctx, objects, subjectType) {
        if (objects.length === 0)
            return new Set();
        const mids = await this.firstHop.listMany(ctx, objects);
        if (mids.length === 0)
            return new Set();
        return this.second.expandSubjectsFromMany(ctx, mids, subjectType);
    }
    // The first-hop fact plus the far set's count.
    async checkLevels(ctx, subject, objectType, ids) {
        if (ids.length === 0 || objectType !== this.firstHop.objectType)
            return new Map();
        if (ids.length * this.firstHop.relations.length > MAX_POINT_LOOKUPS) {
            const all = await this.objectLevels(ctx, [subject], objectType);
            return new Map(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)]));
        }
        const pairs = await this.firstHop.listPairs(ctx, entities(objectType, ids));
        const mids = new Set([...pairs.values()].flat());
        if (mids.size === 0)
            return new Map();
        const far = await this.second.checkLevels(ctx, subject, this.firstHop.intermediateType, [...mids]);
        const out = new Map();
        for (const [objectId, ms] of pairs) {
            const best = Math.min(...ms.map((m) => far.get(m) ?? Infinity));
            if (best < Infinity)
                out.set(objectId, best + 1);
        }
        return out;
    }
    async objectLevels(ctx, subjects, objectType) {
        if (subjects.length === 0 || objectType !== this.firstHop.objectType)
            return new Map();
        const T = this.firstHop.intermediateType;
        const far = await this.second.objectLevels(ctx, subjects, T);
        // One first-hop read per distinct count among the intermediates.
        const byFacts = new Map();
        for (const [mid, facts] of far)
            byFacts.set(facts, [...(byFacts.get(facts) ?? []), mid]);
        const reached = await Promise.all([...byFacts].map(async ([facts, mids]) => at(await this.firstHop.listObjects(ctx, entities(T, mids)), facts)));
        return minOf(reached, 1);
    }
    async subjectLevels(ctx, objects, subjectType) {
        if (objects.length === 0)
            return new Map();
        const mids = await this.firstHop.listMany(ctx, objects);
        if (mids.length === 0)
            return new Map();
        return minOf([await this.second.subjectLevels(ctx, mids, subjectType)], 1);
    }
}
// ---------------------------------------------------------------------------
// Union — OR, with narrowing between children.
// ---------------------------------------------------------------------------
/**
 * `check` probes the cheapest child first (usually the `Materialised` leaf),
 * then runs the rest in parallel (all awaited). `checkBatch*` narrow: each
 * child sees only the candidates earlier children did not cover. `expand*`
 * union every child.
 */
class Union {
    children;
    cost;
    constructor(children) {
        this.children = children;
        this.cost =
            children.length === 0 ? 0 : Math.min(...children.map((c) => c.cost));
    }
    /** Drops `EMPTY`, flattens nested unions, collapses 0/1 children, sorts by cost. */
    static of(...children) {
        const flat = [];
        for (const c of children) {
            if (c === EMPTY)
                continue;
            if (c instanceof Union)
                flat.push(...c.children);
            else
                flat.push(c);
        }
        const unique = [...new Set(flat)];
        if (unique.length === 0)
            return EMPTY;
        if (unique.length === 1)
            return unique[0];
        unique.sort((a, b) => a.cost - b.cost);
        return new Union(unique);
    }
    async check(ctx, subject, object) {
        if (this.children.length === 0)
            return false;
        if (await this.children[0].check(ctx, subject, object))
            return true;
        const rest = this.children.slice(1);
        if (rest.length === 0)
            return false;
        // All remaining children in parallel, and ALL awaited: a first-true race
        // would return while sibling `runQuery` calls are still in flight, which a
        // Convex function (and convex-test) treats as an error after it completes.
        const results = await Promise.all(rest.map((c) => c.check(ctx, subject, object)));
        return results.some(Boolean);
    }
    checkBatch(ctx, subject, objectType, candidateIds) {
        return this.narrow(candidateIds, (c, rest) => c.checkBatch(ctx, subject, objectType, rest));
    }
    checkBatchSubjects(ctx, object, subjectType, ids) {
        return this.narrow(ids, (c, rest) => c.checkBatchSubjects(ctx, object, subjectType, rest));
    }
    expandObjects(ctx, subject, objectType) {
        return this.expandObjectsFromMany(ctx, [subject], objectType);
    }
    expandSubjects(ctx, object, subjectType) {
        return this.expandSubjectsFromMany(ctx, [object], subjectType);
    }
    async expandObjectsFromMany(ctx, subjects, objectType) {
        const all = await Promise.all(this.children.map((c) => c.expandObjectsFromMany(ctx, subjects, objectType)));
        return new Set(all.flatMap((s) => [...s]));
    }
    async expandSubjectsFromMany(ctx, objects, subjectType) {
        const all = await Promise.all(this.children.map((c) => c.expandSubjectsFromMany(ctx, objects, subjectType)));
        return new Set(all.flatMap((s) => [...s]));
    }
    async checkLevels(ctx, subject, objectType, ids) {
        return minOf(await Promise.all(this.children.map((c) => c.checkLevels(ctx, subject, objectType, ids))));
    }
    async objectLevels(ctx, subjects, objectType) {
        return minOf(await Promise.all(this.children.map((c) => c.objectLevels(ctx, subjects, objectType))));
    }
    async subjectLevels(ctx, objects, subjectType) {
        return minOf(await Promise.all(this.children.map((c) => c.subjectLevels(ctx, objects, subjectType))));
    }
    async narrow(candidateIds, run) {
        const hits = new Set();
        let remaining = candidateIds;
        for (const child of this.children) {
            if (remaining.length === 0)
                break;
            const got = await run(child, remaining);
            if (got.size === 0)
                continue;
            for (const id of got)
                hits.add(id);
            remaining = remaining.filter((id) => !hits.has(id));
        }
        return hits;
    }
}
const EMPTY = {
    cost: 0,
    check: async () => false,
    checkBatch: async () => new Set(),
    checkBatchSubjects: async () => new Set(),
    expandObjects: async () => new Set(),
    expandSubjects: async () => new Set(),
    expandObjectsFromMany: async () => new Set(),
    expandSubjectsFromMany: async () => new Set(),
    checkLevels: async () => new Map(),
    objectLevels: async () => new Map(),
    subjectLevels: async () => new Map(),
};
// ---------------------------------------------------------------------------
// Counted — answers by fact count (CONTRACT §4.7).
// ---------------------------------------------------------------------------
/**
 * A plan answered through its `Levels`: an id is in the answer when its
 * fewest-facts derivation found uses at most `maxDepth` facts; if any id's
 * only derivations found are longer, the read THROWS (the write side would
 * have recorded a depth failure instead of a row). `Closure` is one; `Counted`
 * wraps the plan of any other set that reaches a cycle.
 */
class CountedPlan {
    label;
    maxDepth;
    constructor(label, maxDepth) {
        this.label = label;
        this.maxDepth = maxDepth;
    }
    settle(levels, only) {
        const out = new Set();
        let worst = 0;
        for (const id of only ?? levels.keys()) {
            const facts = levels.get(id);
            if (facts === undefined)
                continue;
            if (facts <= this.maxDepth)
                out.add(id);
            else
                worst = Math.max(worst, facts);
        }
        if (worst > 0) {
            throw new Error(`convzibar: ${this.label} found only a derivation of ${worst} facts, more than maxDepth ` +
                `(${this.maxDepth}). Raise maxDepth in createZbar options if the hierarchy is legitimately ` +
                `this deep; the read was refused rather than truncated.`);
        }
        return out;
    }
    async check(ctx, subject, object) {
        return (await this.checkBatch(ctx, subject, object.type, [object.id])).has(object.id);
    }
    async checkBatch(ctx, subject, objectType, ids) {
        return this.settle(await this.checkLevels(ctx, subject, objectType, ids), ids);
    }
    async checkBatchSubjects(ctx, object, subjectType, ids) {
        if (ids.length === 0)
            return new Set();
        return this.settle(await this.subjectLevels(ctx, [object], subjectType), ids);
    }
    expandObjects(ctx, subject, objectType) {
        return this.expandObjectsFromMany(ctx, [subject], objectType);
    }
    expandSubjects(ctx, object, subjectType) {
        return this.expandSubjectsFromMany(ctx, [object], subjectType);
    }
    async expandObjectsFromMany(ctx, subjects, objectType) {
        return this.settle(await this.objectLevels(ctx, subjects, objectType));
    }
    async expandSubjectsFromMany(ctx, objects, subjectType) {
        return this.settle(await this.subjectLevels(ctx, objects, subjectType));
    }
}
/** A non-recursive plan of a set that reaches a cycle, answered by fact count. */
class Counted extends CountedPlan {
    plan;
    cost;
    constructor(plan, label, maxDepth) {
        super(label, maxDepth);
        this.plan = plan;
        this.cost = plan.cost;
    }
    checkLevels(ctx, subject, objectType, ids) {
        return this.plan.checkLevels(ctx, subject, objectType, ids);
    }
    objectLevels(ctx, subjects, objectType) {
        return this.plan.objectLevels(ctx, subjects, objectType);
    }
    subjectLevels(ctx, objects, subjectType) {
        return this.plan.subjectLevels(ctx, objects, subjectType);
    }
}
/**
 * The fixed point of a strongly connected group of sets (a folder tree's
 * `manage ⊇ parent.manage`, a nested group's `member ⊇ group#member`, or a
 * mutual cycle between sets), evaluated as a frontier walk over
 * `(set, node)` pairs with a visited set, at most `maxDepth` steps from where
 * it starts. A derivation of `k` steps (one fact each) ending in a base hit
 * of `b` facts uses `k + b` facts; each id gets its fewest. A walk that
 * reaches the step bound without a hit has found nothing (no, not an error).
 */
class Closure extends CountedPlan {
    nodes;
    cost = 2;
    root;
    /** For the downward (object-enumerating) walk: who steps into each key. */
    stepsInto = new Map();
    constructor(nodes, rootKey, maxDepth) {
        super(`the recursive set ${rootKey}`, maxDepth);
        this.nodes = nodes;
        this.root = nodes.get(rootKey);
        for (const node of nodes.values()) {
            for (const step of node.steps) {
                const arr = this.stepsInto.get(step.target) ?? [];
                arr.push({ node, firstHop: step.firstHop });
                this.stepsInto.set(step.target, arr);
            }
        }
    }
    /**
     * Walk up from the candidates, at most `maxDepth` steps, recording each
     * node's base level and the steps between nodes; each candidate's count is
     * then a shortest-path search over what was read. A node with a one-fact
     * hit is not expanded (nothing past it is shorter). Stops early once every
     * candidate has a derivation within the bound.
     */
    async checkLevels(ctx, subject, objectType, ids) {
        if (objectType !== this.root.objectType || ids.length === 0)
            return new Map();
        const nid = (key, id) => `${key}\u0000${id}`;
        const level = new Map(); // node → its base level, for nodes with a hit
        const up = new Map(); //  node → the nodes it steps into
        const seen = new Set(ids.map((id) => nid(this.root.key, id)));
        const best = (id) => {
            // Breadth-first from the candidate: k steps to a node with level b.
            let found = Infinity;
            let ring = [nid(this.root.key, id)];
            const visited = new Set(ring);
            for (let k = 0; ring.length > 0 && k <= this.maxDepth; k++) {
                const next = [];
                for (const n of ring) {
                    const b = level.get(n);
                    if (b !== undefined)
                        found = Math.min(found, k + b);
                    for (const p of up.get(n) ?? []) {
                        if (!visited.has(p)) {
                            visited.add(p);
                            next.push(p);
                        }
                    }
                }
                ring = next;
            }
            return found;
        };
        let frontier = new Map([
            [this.root.key, new Set(ids)],
        ]);
        let open = [...ids];
        for (let depth = 0; frontier.size > 0; depth++) {
            const keys = [...frontier.keys()];
            const hits = await Promise.all(keys.map((key) => {
                const node = this.nodes.get(key);
                return node.base.checkLevels(ctx, subject, node.objectType, [
                    ...frontier.get(key),
                ]);
            }));
            keys.forEach((key, i) => {
                for (const [id, b] of hits[i])
                    level.set(nid(key, id), b);
            });
            open = open.filter((id) => best(id) > this.maxDepth);
            if (open.length === 0 || depth === this.maxDepth)
                break;
            const next = new Map();
            await Promise.all(keys.flatMap((key) => {
                const node = this.nodes.get(key);
                const expand = [...frontier.get(key)].filter((id) => level.get(nid(key, id)) !== 1);
                if (expand.length === 0)
                    return [];
                return node.steps.map(async (step) => {
                    const pairs = await step.firstHop.listPairs(ctx, entities(node.objectType, expand));
                    for (const [childId, mids] of pairs) {
                        const child = nid(key, childId);
                        for (const mid of mids) {
                            const parent = nid(step.target, mid);
                            const arr = up.get(child) ?? [];
                            arr.push(parent);
                            up.set(child, arr);
                            if (!seen.has(parent)) {
                                seen.add(parent);
                                const set = next.get(step.target) ?? new Set();
                                set.add(mid);
                                next.set(step.target, set);
                            }
                        }
                    }
                });
            }));
            frontier = next;
        }
        const out = new Map();
        for (const id of ids) {
            const b = best(id);
            if (b < Infinity)
                out.set(id, b);
        }
        return out;
    }
    /**
     * Walk up from the objects, at most `maxDepth` steps, breadth-first (each
     * node at its fewest steps); a subject found by a node `k` steps up with a
     * base level `b` has a derivation of `k + b` facts.
     */
    async subjectLevels(ctx, objects, subjectType) {
        const start = objects
            .filter((o) => o.type === this.root.objectType)
            .map((o) => o.id);
        const found = new Map();
        if (start.length === 0)
            return found;
        const visited = new Map([
            [this.root.key, new Set(start)],
        ]);
        let frontier = new Map([
            [this.root.key, new Set(start)],
        ]);
        for (let depth = 0; frontier.size > 0; depth++) {
            const next = new Map();
            await Promise.all([...frontier].flatMap(([key, ids]) => {
                const node = this.nodes.get(key);
                const ents = entities(node.objectType, ids);
                return [
                    node.base
                        .subjectLevels(ctx, ents, subjectType)
                        .then((hits) => minInto(found, hits, depth)),
                    ...(depth === this.maxDepth
                        ? []
                        : node.steps.map(async (step) => {
                            for (const mid of await step.firstHop.listMany(ctx, ents)) {
                                addNew(visited, next, step.target, mid.id);
                            }
                        })),
                ];
            }));
            frontier = next;
        }
        return found;
    }
    /**
     * Seed every member with the objects the subjects reach through its base
     * (each with its count), then push down along the steps for at most
     * `maxDepth` rounds, one fact per step, keeping each node's fewest facts
     * (a node is pushed again only when its count improves).
     */
    async objectLevels(ctx, subjects, objectType) {
        if (objectType !== this.root.objectType || subjects.length === 0)
            return new Map();
        const levels = new Map(); // key → id → fewest facts
        const seeds = await Promise.all([...this.nodes.values()].map(async (n) => [
            n.key,
            await n.base.objectLevels(ctx, subjects, n.objectType),
        ]));
        let frontier = new Map();
        for (const [key, hits] of seeds) {
            levels.set(key, new Map(hits));
            if (hits.size > 0)
                frontier.set(key, new Map(hits));
        }
        for (let round = 1; round <= this.maxDepth && frontier.size > 0; round++) {
            const next = new Map();
            await Promise.all([...frontier].flatMap(([key, ids]) => (this.stepsInto.get(key) ?? []).flatMap(({ node, firstHop }) => {
                // One read per distinct count among the pushed nodes.
                const byFacts = new Map();
                for (const [mid, facts] of ids)
                    byFacts.set(facts, [...(byFacts.get(facts) ?? []), mid]);
                return [...byFacts].map(async ([facts, mids]) => {
                    const objects = await firstHop.listObjects(ctx, entities(this.nodes.get(key).objectType, mids));
                    const known = levels.get(node.key) ?? new Map();
                    levels.set(node.key, known);
                    for (const id of objects) {
                        if ((known.get(id) ?? Infinity) <= facts + 1)
                            continue;
                        known.set(id, facts + 1);
                        const pushed = next.get(node.key) ?? new Map();
                        pushed.set(id, facts + 1);
                        next.set(node.key, pushed);
                    }
                });
            })));
            frontier = next;
        }
        return levels.get(this.root.key) ?? new Map();
    }
}
function addNew(seen, next, key, id) {
    const s = seen.get(key) ?? new Set();
    if (s.has(id))
        return;
    s.add(id);
    seen.set(key, s);
    const n = next.get(key) ?? new Set();
    n.add(id);
    next.set(key, n);
}
// ============================================================================
// Compiling sets into plans.
// ============================================================================
const setKey = (objectType, name) => `${objectType}#${name}`;
function getSet(config, objectType, name) {
    return config.sets[objectType]?.[name];
}
/** `inherits[O][S]`: the set and everything it inherits (always contains S when S exists). */
function closureOf(config, objectType, name) {
    return (config.inherits[objectType]?.[name] ??
        (getSet(config, objectType, name) ? [name] : []));
}
function factRelationsOf(config, objectType, name) {
    return config.factRelations[objectType]?.[name] ?? [];
}
/**
 * The computed walks/expands arms of a set's whole inherits closure, grouped
 * by (intermediate type, far set). Arms with the same far set are one Compose
 * over the union of their first-hop relations — Compose distributes over a
 * union of first hops, so this is the same answer with fewer reads.
 */
function computedHops(config, objectType, name) {
    const hops = new Map();
    const add = (T, target, rels) => {
        if (rels.length === 0)
            return;
        const k = setKey(T, target);
        const h = hops.get(k) ?? {
            intermediateType: T,
            target,
            rels: new Set(),
        };
        for (const r of rels)
            h.rels.add(r);
        hops.set(k, h);
    };
    for (const member of closureOf(config, objectType, name)) {
        for (const arm of getSet(config, objectType, member)?.arms ?? []) {
            if (arm.kind === "expands" && !arm.materialized) {
                add(arm.subjectType, arm.targetSet, factRelationsOf(config, objectType, member));
            }
            else if (arm.kind === "walks" && !arm.materialized) {
                add(arm.viaType, arm.targetSet, factRelationsOf(config, objectType, arm.viaRelation));
            }
        }
    }
    return [...hops.values()];
}
/** Members whose rows are in `effectiveRelationships`: writable ones (fact mirrors) and ones with materialized arms. */
function materialisedMembers(config, objectType, name) {
    return closureOf(config, objectType, name).filter((m) => {
        const set = getSet(config, objectType, m);
        if (!set)
            return false;
        return (set.writable ||
            set.arms.some((a) => (a.kind === "expands" || a.kind === "walks") && a.materialized));
    });
}
function inverseArms(config, objectType, name) {
    const out = [];
    for (const member of closureOf(config, objectType, name)) {
        for (const arm of getSet(config, objectType, member)?.arms ?? []) {
            if (arm.kind === "inverse") {
                out.push({
                    set: member,
                    subjectType: arm.subjectType,
                    relation: arm.relation,
                });
            }
        }
    }
    return out;
}
const planStates = new WeakMap();
function stateOf(z) {
    let s = planStates.get(z.graphConfig);
    if (!s) {
        s = {
            scc: recursiveComponents(z.graphConfig),
            nodes: new Map(),
            parts: new Map(),
        };
        planStates.set(z.graphConfig, s);
    }
    return s;
}
/**
 * Tarjan's SCCs over the read-time "set → far set" graph (computed
 * walks/expands arms only: materialized arms are rows, so they never recurse
 * at read time). Returns, for each set in a cycle (an SCC of size > 1 or a
 * self-loop), the members of its component: the planner needs to know WHICH
 * arms re-enter it, so the component is its own, not the compiler's.
 */
function recursiveComponents(config) {
    const edges = new Map();
    for (const [O, sets] of Object.entries(config.sets)) {
        for (const name of Object.keys(sets)) {
            edges.set(setKey(O, name), computedHops(config, O, name).map((h) => setKey(h.intermediateType, h.target)));
        }
    }
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const out = new Map();
    let counter = 0;
    const visit = (v) => {
        index.set(v, counter);
        low.set(v, counter);
        counter++;
        stack.push(v);
        onStack.add(v);
        for (const w of edges.get(v) ?? []) {
            if (!edges.has(w))
                continue;
            if (!index.has(w)) {
                visit(w);
                low.set(v, Math.min(low.get(v), low.get(w)));
            }
            else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v), index.get(w)));
            }
        }
        if (low.get(v) === index.get(v)) {
            const comp = [];
            let w;
            do {
                w = stack.pop();
                onStack.delete(w);
                comp.push(w);
            } while (w !== v);
            if (comp.length > 1 || (edges.get(v) ?? []).includes(v)) {
                for (const m of comp)
                    out.set(m, comp);
            }
        }
    };
    for (const v of edges.keys())
        if (!index.has(v))
            visit(v);
    return out;
}
function memo(z, key, make) {
    const { nodes } = stateOf(z);
    let n = nodes.get(key);
    if (!n) {
        n = make();
        nodes.set(key, n);
    }
    return n;
}
/**
 * The branches of `(objectType, name)` other than its own recursive steps.
 * `inComponent` (for a member of a recursive component) names the far sets
 * whose arms become Closure steps instead of Composes.
 */
function buildBranches(z, objectType, name, inComponent) {
    const config = z.graphConfig;
    const materialised = materialisedMembers(config, objectType, name);
    const branches = [];
    const steps = [];
    for (const inv of inverseArms(config, objectType, name)) {
        branches.push(memo(z, `inv:${objectType}|${inv.subjectType}#${inv.relation}`, () => {
            return new Inverse(z, objectType, inv.subjectType, inv.relation);
        }));
    }
    for (const hop of computedHops(config, objectType, name)) {
        const rels = [...hop.rels].sort();
        const firstHop = new EdgeExpand(z, objectType, hop.intermediateType, rels);
        const target = setKey(hop.intermediateType, hop.target);
        if (inComponent?.has(target)) {
            steps.push({ firstHop, target });
            continue;
        }
        branches.push(memo(z, `compose:${objectType}|${rels.join(",")}|${target}`, () => {
            return new Compose(firstHop, planSet(z, hop.intermediateType, hop.target));
        }));
    }
    return { materialised, branches, steps };
}
function materialisedLeaf(z, objectType, relations) {
    if (relations.length === 0)
        return EMPTY;
    return memo(z, `mat:${objectType}|${relations.join(",")}`, () => {
        return new Materialised(z, objectType, relations);
    });
}
function setParts(z, objectType, name) {
    const state = stateOf(z);
    const key = setKey(objectType, name);
    const cached = state.parts.get(key);
    if (cached)
        return cached;
    const set = getSet(z.graphConfig, objectType, name);
    const maxDepth = z.graphConfig.maxDepth ?? 16;
    let parts;
    if (!set) {
        parts = { materialised: [], branches: [], plan: EMPTY, counted: false };
    }
    else {
        const component = state.scc.get(key);
        if (component) {
            // Recursive: the whole component is one Closure, entered at this set.
            const members = new Set(component);
            const nodes = new Map();
            for (const k of component) {
                const [O, S] = splitKey(k);
                const b = buildBranches(z, O, S, members);
                nodes.set(k, {
                    key: k,
                    objectType: O,
                    base: Union.of(materialisedLeaf(z, O, b.materialised), ...b.branches),
                    steps: b.steps,
                });
            }
            const closure = memo(z, `closure:${key}`, () => new Closure(nodes, key, maxDepth));
            parts = {
                materialised: materialisedMembers(z.graphConfig, objectType, name),
                branches: [closure],
                plan: closure,
                counted: true,
            };
        }
        else {
            const b = buildBranches(z, objectType, name);
            const plan = Union.of(materialisedLeaf(z, objectType, b.materialised), ...b.branches);
            // A set that reaches a cycle (through any arm) is answered by fact count.
            const counted = set.maxLineage === null;
            parts = {
                materialised: b.materialised,
                branches: b.branches,
                plan: counted
                    ? memo(z, `counted:${key}`, () => new Counted(plan, `the set ${key}`, maxDepth))
                    : plan,
                counted,
            };
        }
    }
    state.parts.set(key, parts);
    return parts;
}
function splitKey(key) {
    const i = key.indexOf("#");
    return [key.slice(0, i), key.slice(i + 1)];
}
/**
 * Compile `(objectType, set)` — a relation or a permission — into a plan
 * (CONTRACT §3). Memoised per compiled config. An unknown set is `EMPTY`.
 *
 *   Union( Materialised(writable members ∪ members with materialized arms),
 *          Inverse per inverse arm,
 *          Compose(first hop = facts, planSet(T, target)) per computed walks/expands arm )
 *
 * A set in a recursive component is a `Closure` over the component instead;
 * any other set that reaches a cycle (`maxLineage` null) is that union
 * wrapped in `Counted`, so its answers are settled by fact count (CONTRACT
 * §4.7). The far-set graph outside cycles is a DAG, so the recursion through
 * `planSet` terminates.
 */
export function planSet(z, objectType, set) {
    return setParts(z, objectType, set).plan;
}
// ============================================================================
// getPermissions: many permissions on one (subject, object).
// ============================================================================
/**
 * Granted permissions, in input order. One batched `Materialised` read covers
 * every permission's materialised members (a hit there is a grant: those rows
 * are a subset of the set); the remaining permissions run their other
 * branches, each distinct branch at most once (plans are memoised by
 * structure, so permissions sharing an arm share the branch object).
 */
export async function evaluateManyPermissions(z, ctx, subject, object, permissions) {
    const parts = permissions.map((p) => ({
        permission: p,
        ...setParts(z, object.type, p),
    }));
    const allMat = [...new Set(parts.flatMap((p) => p.materialised))];
    const matched = new Set();
    if (allMat.length > 0) {
        const rows = await ctx.runQuery(z.component.queries.effectiveForward, {
            subjects: [{ type: subject.type, id: subject.id }],
            relations: allMat,
            objectPoints: [buildScopeKey(object.type, object.id)],
        });
        for (const r of rows)
            matched.add(r.relation);
    }
    const granted = new Set();
    const pending = parts.filter((p) => {
        if (p.materialised.some((m) => matched.has(m))) {
            granted.add(p.permission);
            return false;
        }
        return p.branches.length > 0;
    });
    // A counted set is settled on its whole plan; every other set's branches
    // are shared between permissions and each run at most once.
    const results = new Map();
    for (const p of pending) {
        for (const b of p.counted ? [p.plan] : p.branches) {
            if (!results.has(b))
                results.set(b, b.check(ctx, subject, object));
        }
    }
    await Promise.all(pending.map(async (p) => {
        for (const b of p.counted ? [p.plan] : p.branches) {
            if (await results.get(b)) {
                granted.add(p.permission);
                return;
            }
        }
    }));
    return permissions.filter((p) => granted.has(p));
}
// ============================================================================
// .via() — scope a list to the structural neighbourhood of pinned entities.
//
//   subject … via[0] ~ via[1] ~ … ~ via[last] … object
//
// The result is exactly the full list intersected with the structural scope
// (CONTRACT §4.9):
//   • the vias must form a chain of structural links (`~`: a fact between
//     consecutive vias on a relation the compiled arms declare between their
//     types — `structural.ts`);
//   • the enumerated side is restricted to the structural neighbours of the
//     nearest via (objects of via[last], subjects of via[0]);
//   • every candidate is verified through the set's own plan. Structure only
//     says where to look; the plan decides who holds the set. Always run.
//
// There is no subject-side gate: a gate ("does the subject hold something on
// the via?") would drop objects in scope that the subject reaches by another
// arm, which is not the intersection. No "every relation on the via" fallback
// either: a via type the compiled arms never connect to the listed type has an
// empty scope, by definition.
// ============================================================================
/**
 * Nodes of `otherType` linked to `via` by a structural fact in either
 * direction (`structural.ts`). `ids` narrows the read to points.
 */
async function structuralNeighbors(z, ctx, via, otherType, ids) {
    const { outgoing, incoming } = structuralRelations(z.graphConfig, via.type, otherType);
    const far = { type: otherType, ids };
    const [out, inc] = await Promise.all([
        readForward(z, ctx, "facts", [via], outgoing, far),
        readReverse(z, ctx, "facts", [via], incoming, far),
    ]);
    return new Set([...objectIdsOf(out), ...subjectIdsOf(inc)]);
}
async function chainConnected(z, ctx, via) {
    const links = await Promise.all(via
        .slice(1)
        .map(async (next, i) => (await structuralNeighbors(z, ctx, next, via[i].type, [via[i].id])).has(via[i].id)));
    return links.every(Boolean);
}
/** Objects of `objectType` that `subject` holds `plan` on, within the structural scope of `via[last]`. */
export async function collectViaObjects(z, ctx, plan, subject, via, objectType) {
    if (via.length === 0)
        return new Set();
    const [connected, candidates] = await Promise.all([
        chainConnected(z, ctx, via),
        structuralNeighbors(z, ctx, via[via.length - 1], objectType),
    ]);
    if (!connected || candidates.size === 0)
        return new Set();
    return plan.checkBatch(ctx, subject, objectType, [...candidates]);
}
/** Subjects of `subjectType` holding `plan` on `object`, within the structural scope of `via[0]`. */
export async function collectViaSubjects(z, ctx, plan, object, via, subjectType) {
    if (via.length === 0)
        return new Set();
    const [connected, candidates] = await Promise.all([
        chainConnected(z, ctx, via),
        structuralNeighbors(z, ctx, via[0], subjectType),
    ]);
    if (!connected || candidates.size === 0)
        return new Set();
    return plan.checkBatchSubjects(ctx, object, subjectType, [...candidates]);
}
//# sourceMappingURL=traversal.js.map