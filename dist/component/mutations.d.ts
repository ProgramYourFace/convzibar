/**
 * Write entry points of the engine (EXPANSION.md §2.9). Every public mutation
 * loads the config (registering it on first use) and makes it the active
 * config (`envOf`; a change owes a `rebuild`), runs the seed in the caller's
 * transaction (`insertFact` / `deleteFact` in expand.ts), and hands its items
 * to `execute`, which runs what fits the budget, depth-first; what is left is
 * enqueued as ONE continuation on `expansionPool` (`executeAndContinue`).
 */
import { type MutationCtx } from "./_generated/server";
import { type Env, type Stats, type WorkItem } from "./expand";
import type { GraphConfig } from "./types";
/** Attempts of one cursor before it is recorded in `expansionFailures` (CONTRACT §5.7). */
export declare const MAX_ATTEMPTS = 5;
/**
 * The environment of a transaction. `config` null is config-free work: a
 * removal started by maintenance (CONTRACT §5.5 reads no rule), on the real
 * workpool, with the default budget.
 */
export declare function envFor(config: GraphConfig | null, configHash: string | null, budget?: number): Env;
/**
 * Run `items` in this transaction (`execute`), then enqueue what is left,
 * followed by `owed` (work this transaction owes but does not start), as at
 * most ONE continuation with a fresh budget (CONTRACT §5.3, I5).
 */
export declare function executeAndContinue(ctx: MutationCtx, env: Env, items: WorkItem[], owed?: WorkItem[]): Promise<Stats>;
/** One chunk: run the cursor's items under its budget (CONTRACT §5.3); enqueue at most one continuation. */
export declare const continueExpansion: import("convex/server").RegisteredMutation<"internal", any, Promise<null>>;
/**
 * Workpool `onComplete` of every chunk (P4). A failed or canceled chunk wrote
 * nothing; re-enqueue the same cursor (the same list) with half the budget,
 * and after `MAX_ATTEMPTS` record it. Stale items are dropped instead (Lemma
 * Q). Reads its arguments, the active hash and the workpool's own state,
 * never the data its chunk read, so it cannot fail for the reason its chunk
 * did.
 */
export declare const chunkCompleted: import("convex/server").RegisteredMutation<"internal", {
    result: {
        kind: "failed";
        error: string;
    } | {
        kind: "canceled";
    } | {
        kind: "success";
        returnValue: any;
    };
    context: any;
    workId: import("@convex-dev/workpool").WorkId;
}, Promise<null>>;
/**
 * Delete the record and re-enqueue its cursor: the same items and hash, the
 * budget reset to the config's `writeBudget` and `attempts` to 0. Stale items
 * are not re-enqueued (Lemma Q: nothing is owed to them).
 */
export declare const resumeExpansion: import("convex/server").RegisteredMutation<"public", {
    failureId: import("convex/values").GenericId<"expansionFailures">;
}, Promise<null>>;
export declare const addRelation: import("convex/server").RegisteredMutation<"public", {
    properties?: any;
    graphConfig?: any;
    object: {
        type: string;
        id: string;
    };
    relation: string;
    subject: {
        type: string;
        id: string;
    };
    configHash: string;
}, Promise<import("./_generated/dataModel").Id<"relationships">>>;
export declare const removeRelation: import("convex/server").RegisteredMutation<"public", {
    graphConfig?: any;
    object: {
        type: string;
        id: string;
    };
    relation: string;
    subject: {
        type: string;
        id: string;
    };
    configHash: string;
}, Promise<boolean>>;
/**
 * Replace every other relation in `objectRelations` that the subject holds on
 * the object with `relation`, in one transaction. The add items run before
 * the removal items (EXPANSION.md §2.9: a row both facts derive gains its new
 * path before it loses the old one, so it never disappears).
 */
export declare const setRelation: import("convex/server").RegisteredMutation<"public", {
    properties?: any;
    graphConfig?: any;
    object: {
        type: string;
        id: string;
    };
    relation: string;
    subject: {
        type: string;
        id: string;
    };
    objectRelations: string[];
    configHash: string;
}, Promise<import("./_generated/dataModel").Id<"relationships">>>;
/**
 * Remove every fact that touches the entity, through the same removal path,
 * by cursor. The counts cover what this transaction did.
 */
export declare const deleteEntity: import("convex/server").RegisteredMutation<"public", {
    graphConfig?: any;
    entity: {
        type: string;
        id: string;
    };
    configHash: string;
}, Promise<{
    relationshipsRemoved: number;
    effectiveRelationshipsRemoved: number;
}>>;
/**
 * CONTRACT §5.6: re-derive from every fact under this config (phase derive),
 * then retire every path this config does not justify (phase retire).
 * Continues itself in the workpool; idempotent and resumable. Also enqueued
 * automatically by any write that changes the active config (`envOf`).
 */
export declare const rebuild: import("convex/server").RegisteredMutation<"public", {
    graphConfig?: any;
    configHash: string;
}, Promise<null>>;
export declare const getMockWorkpool: import("convex/server").RegisteredQuery<"internal", {}, Promise<any>>;
export declare const deleteMockWorkpoolTask: import("convex/server").RegisteredMutation<"internal", {
    id: string;
}, Promise<null>>;
//# sourceMappingURL=mutations.d.ts.map