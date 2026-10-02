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
export declare const deleteFactsByRelation: import("convex/server").RegisteredMutation<"public", {
    entityTypes?: string[] | undefined;
    relations: string[];
    cursor: string | null;
    numItems: number;
}, Promise<{
    scanned: any;
    deleted: number;
    mirrorsTagged: number;
    continueCursor: string;
    isDone: boolean;
}>>;
/**
 * Delete up to `numItems` effective rows whose subject key (or object key)
 * starts with `prefix` — e.g. `'user:'` for every row of an entity type the
 * schema dropped — with their lineage rows (Invariant L). Direct deletes, no
 * cascade (see the file header). Each call re-reads the range from its start
 * (deleted rows leave it), so it needs no cursor: `isDone` once a call finds
 * fewer than `numItems`.
 */
export declare const deleteEffectiveRowsByKeyPrefix: import("convex/server").RegisteredMutation<"public", {
    numItems: number;
    prefix: string;
    side: "object" | "subject";
}, Promise<{
    deleted: number;
    isDone: boolean;
}>>;
/**
 * One page of facts in creation order, keeping those whose relation is in
 * `relations`. For each kept fact, `siblings` lists which of `pairRelations`
 * the same (subject, object) pair also holds as facts — one exact index read
 * per (fact, relation). The caller decides what to do and removes through the
 * engine's removal path.
 */
export declare const pageFacts: import("convex/server").RegisteredQuery<"public", {
    pairRelations?: string[] | undefined;
    relations: string[];
    cursor: string | null;
    numItems: number;
}, Promise<{
    facts: {
        id: string;
        subject: {
            type: any;
            id: any;
        };
        relation: any;
        object: {
            type: any;
            id: any;
        };
        siblings: string[];
    }[];
    continueCursor: string;
    isDone: boolean;
}>>;
//# sourceMappingURL=maintenance.d.ts.map