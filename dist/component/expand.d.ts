/**
 * The write-time BFS (CONTRACT §5). Read `EXPANSION.md` next to this file
 * first: it defines the state, the functions below (same names, same order),
 * the invariants they keep (L, W, I1–I4) and proves P1–P6.
 *
 *   2.1 ruleIndex                 rules keyed by the shape of the row that triggers them
 *   2.2 derive                    one rule application, pure
 *   2.3 mergePath                 (paths.ts)
 *   2.4 writePaths, ensureMirror, ensureLineage, dropPath, deleteRow
 *                                 the only writers of paths and lineage
 *   2.5 triggersOf                the add items of a path just stored
 *   2.6 Budget, scan, scanIndexAfter   the cost of a transaction; one paged index range
 *   2.7 step*, derivationsWithin  one function per work-item kind; retire's in-memory re-derivation
 *   2.8 execute, parseCursor      a pending list under the budget (depth-first); the continuation payload
 *   2.9 insertFact, deleteFact    the seed of every write (called by mutations.ts)
 */
import { type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { GraphConfig } from "./types";
type Fact = Doc<"relationships">;
type Row = Doc<"effectiveRelationships">;
type Entity = {
    type: string;
    id: string;
};
declare const vRowKey: import("convex/values").VObject<{
    relation: string;
    subjectKey: string;
    objectKey: string;
}, {
    subjectKey: import("convex/values").VString<string, "required">;
    relation: import("convex/values").VString<string, "required">;
    objectKey: import("convex/values").VString<string, "required">;
}, "required", "relation" | "subjectKey" | "objectKey">;
type RowKey = Infer<typeof vRowKey>;
declare const vWorkItem: import("convex/values").VUnion<{
    rule: string;
    fact: import("convex/values").GenericId<"relationships">;
    kind: "add";
    trigger: "first";
    part: number;
    after: string | null;
} | {
    rule: string;
    fact: import("convex/values").GenericId<"relationships">;
    kind: "add";
    trigger: "inverse";
    after: string | null;
} | {
    paths: string[];
    rule: string;
    kind: "add";
    trigger: "second";
    after: string | null;
    row: {
        relation: string;
        subjectKey: string;
        objectKey: string;
    };
} | {
    fact: string;
    kind: "remove";
} | {
    entity: {
        type: string;
        id: string;
    };
    kind: "deleteEntity";
} | {
    kind: "rebuild";
    after: string[] | null;
    phase: "derive" | "retire";
}, [import("convex/values").VObject<{
    rule: string;
    fact: import("convex/values").GenericId<"relationships">;
    kind: "add";
    trigger: "first";
    part: number;
    after: string | null;
}, {
    kind: import("convex/values").VLiteral<"add", "required">;
    trigger: import("convex/values").VLiteral<"first", "required">;
    fact: import("convex/values").VId<import("convex/values").GenericId<"relationships">, "required">;
    rule: import("convex/values").VString<string, "required">;
    /** Index into `[...secondHop.relations, ...secondHop.inverses]`. */
    part: import("convex/values").VFloat64<number, "required">;
    after: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
}, "required", "rule" | "fact" | "kind" | "trigger" | "part" | "after">, import("convex/values").VObject<{
    rule: string;
    fact: import("convex/values").GenericId<"relationships">;
    kind: "add";
    trigger: "inverse";
    after: string | null;
}, {
    kind: import("convex/values").VLiteral<"add", "required">;
    trigger: import("convex/values").VLiteral<"inverse", "required">;
    fact: import("convex/values").VId<import("convex/values").GenericId<"relationships">, "required">;
    rule: import("convex/values").VString<string, "required">;
    after: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
}, "required", "rule" | "fact" | "kind" | "trigger" | "after">, import("convex/values").VObject<{
    paths: string[];
    rule: string;
    kind: "add";
    trigger: "second";
    after: string | null;
    row: {
        relation: string;
        subjectKey: string;
        objectKey: string;
    };
}, {
    kind: import("convex/values").VLiteral<"add", "required">;
    trigger: import("convex/values").VLiteral<"second", "required">;
    row: import("convex/values").VObject<{
        relation: string;
        subjectKey: string;
        objectKey: string;
    }, {
        subjectKey: import("convex/values").VString<string, "required">;
        relation: import("convex/values").VString<string, "required">;
        objectKey: import("convex/values").VString<string, "required">;
    }, "required", "relation" | "subjectKey" | "objectKey">;
    rule: import("convex/values").VString<string, "required">;
    /** The `pathId`s of the paths whose store owes this item: it derives from these only (§2.5). */
    paths: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
    after: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
}, "required", "paths" | "rule" | "kind" | "trigger" | "after" | "row" | "row.relation" | "row.subjectKey" | "row.objectKey">, import("convex/values").VObject<{
    fact: string;
    kind: "remove";
}, {
    kind: import("convex/values").VLiteral<"remove", "required">;
    fact: import("convex/values").VString<string, "required">;
}, "required", "fact" | "kind">, import("convex/values").VObject<{
    entity: {
        type: string;
        id: string;
    };
    kind: "deleteEntity";
}, {
    kind: import("convex/values").VLiteral<"deleteEntity", "required">;
    entity: import("convex/values").VObject<{
        type: string;
        id: string;
    }, {
        type: import("convex/values").VString<string, "required">;
        id: import("convex/values").VString<string, "required">;
    }, "required", "type" | "id">;
}, "required", "entity" | "kind" | "entity.type" | "entity.id">, import("convex/values").VObject<{
    kind: "rebuild";
    after: string[] | null;
    phase: "derive" | "retire";
}, {
    kind: import("convex/values").VLiteral<"rebuild", "required">;
    phase: import("convex/values").VUnion<"derive" | "retire", [import("convex/values").VLiteral<"derive", "required">, import("convex/values").VLiteral<"retire", "required">], "required", never>;
    /** The last index key processed (all fields of the scanned index). */
    after: import("convex/values").VUnion<string[] | null, [import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">, import("convex/values").VNull<null, "required">], "required", never>;
}, "required", "kind" | "after" | "phase">], "required", "entity" | "paths" | "rule" | "fact" | "kind" | "trigger" | "part" | "after" | "row" | "row.relation" | "row.subjectKey" | "row.objectKey" | "entity.type" | "entity.id" | "phase">;
export type WorkItem = Infer<typeof vWorkItem>;
/**
 * The continuation payload handed to the workpool (CONTRACT §5.3): the
 * unfinished part of one transaction's pending list, head first (each
 * in-progress item carries its own cursor), bounded by the schema (EXPANSION.md
 * Lemma B). `configHash` is null for config-free work (a removal started by
 * maintenance): removal reads no rule (CONTRACT §5.5).
 */
export declare const vCursor: import("convex/values").VObject<{
    attempts: number;
    items: ({
        rule: string;
        fact: import("convex/values").GenericId<"relationships">;
        kind: "add";
        trigger: "first";
        part: number;
        after: string | null;
    } | {
        rule: string;
        fact: import("convex/values").GenericId<"relationships">;
        kind: "add";
        trigger: "inverse";
        after: string | null;
    } | {
        paths: string[];
        rule: string;
        kind: "add";
        trigger: "second";
        after: string | null;
        row: {
            relation: string;
            subjectKey: string;
            objectKey: string;
        };
    } | {
        fact: string;
        kind: "remove";
    } | {
        entity: {
            type: string;
            id: string;
        };
        kind: "deleteEntity";
    } | {
        kind: "rebuild";
        after: string[] | null;
        phase: "derive" | "retire";
    })[];
    configHash: string | null;
    budget: number;
}, {
    items: import("convex/values").VArray<({
        rule: string;
        fact: import("convex/values").GenericId<"relationships">;
        kind: "add";
        trigger: "first";
        part: number;
        after: string | null;
    } | {
        rule: string;
        fact: import("convex/values").GenericId<"relationships">;
        kind: "add";
        trigger: "inverse";
        after: string | null;
    } | {
        paths: string[];
        rule: string;
        kind: "add";
        trigger: "second";
        after: string | null;
        row: {
            relation: string;
            subjectKey: string;
            objectKey: string;
        };
    } | {
        fact: string;
        kind: "remove";
    } | {
        entity: {
            type: string;
            id: string;
        };
        kind: "deleteEntity";
    } | {
        kind: "rebuild";
        after: string[] | null;
        phase: "derive" | "retire";
    })[], import("convex/values").VUnion<{
        rule: string;
        fact: import("convex/values").GenericId<"relationships">;
        kind: "add";
        trigger: "first";
        part: number;
        after: string | null;
    } | {
        rule: string;
        fact: import("convex/values").GenericId<"relationships">;
        kind: "add";
        trigger: "inverse";
        after: string | null;
    } | {
        paths: string[];
        rule: string;
        kind: "add";
        trigger: "second";
        after: string | null;
        row: {
            relation: string;
            subjectKey: string;
            objectKey: string;
        };
    } | {
        fact: string;
        kind: "remove";
    } | {
        entity: {
            type: string;
            id: string;
        };
        kind: "deleteEntity";
    } | {
        kind: "rebuild";
        after: string[] | null;
        phase: "derive" | "retire";
    }, [import("convex/values").VObject<{
        rule: string;
        fact: import("convex/values").GenericId<"relationships">;
        kind: "add";
        trigger: "first";
        part: number;
        after: string | null;
    }, {
        kind: import("convex/values").VLiteral<"add", "required">;
        trigger: import("convex/values").VLiteral<"first", "required">;
        fact: import("convex/values").VId<import("convex/values").GenericId<"relationships">, "required">;
        rule: import("convex/values").VString<string, "required">;
        /** Index into `[...secondHop.relations, ...secondHop.inverses]`. */
        part: import("convex/values").VFloat64<number, "required">;
        after: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    }, "required", "rule" | "fact" | "kind" | "trigger" | "part" | "after">, import("convex/values").VObject<{
        rule: string;
        fact: import("convex/values").GenericId<"relationships">;
        kind: "add";
        trigger: "inverse";
        after: string | null;
    }, {
        kind: import("convex/values").VLiteral<"add", "required">;
        trigger: import("convex/values").VLiteral<"inverse", "required">;
        fact: import("convex/values").VId<import("convex/values").GenericId<"relationships">, "required">;
        rule: import("convex/values").VString<string, "required">;
        after: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    }, "required", "rule" | "fact" | "kind" | "trigger" | "after">, import("convex/values").VObject<{
        paths: string[];
        rule: string;
        kind: "add";
        trigger: "second";
        after: string | null;
        row: {
            relation: string;
            subjectKey: string;
            objectKey: string;
        };
    }, {
        kind: import("convex/values").VLiteral<"add", "required">;
        trigger: import("convex/values").VLiteral<"second", "required">;
        row: import("convex/values").VObject<{
            relation: string;
            subjectKey: string;
            objectKey: string;
        }, {
            subjectKey: import("convex/values").VString<string, "required">;
            relation: import("convex/values").VString<string, "required">;
            objectKey: import("convex/values").VString<string, "required">;
        }, "required", "relation" | "subjectKey" | "objectKey">;
        rule: import("convex/values").VString<string, "required">;
        /** The `pathId`s of the paths whose store owes this item: it derives from these only (§2.5). */
        paths: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
        after: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    }, "required", "paths" | "rule" | "kind" | "trigger" | "after" | "row" | "row.relation" | "row.subjectKey" | "row.objectKey">, import("convex/values").VObject<{
        fact: string;
        kind: "remove";
    }, {
        kind: import("convex/values").VLiteral<"remove", "required">;
        fact: import("convex/values").VString<string, "required">;
    }, "required", "fact" | "kind">, import("convex/values").VObject<{
        entity: {
            type: string;
            id: string;
        };
        kind: "deleteEntity";
    }, {
        kind: import("convex/values").VLiteral<"deleteEntity", "required">;
        entity: import("convex/values").VObject<{
            type: string;
            id: string;
        }, {
            type: import("convex/values").VString<string, "required">;
            id: import("convex/values").VString<string, "required">;
        }, "required", "type" | "id">;
    }, "required", "entity" | "kind" | "entity.type" | "entity.id">, import("convex/values").VObject<{
        kind: "rebuild";
        after: string[] | null;
        phase: "derive" | "retire";
    }, {
        kind: import("convex/values").VLiteral<"rebuild", "required">;
        phase: import("convex/values").VUnion<"derive" | "retire", [import("convex/values").VLiteral<"derive", "required">, import("convex/values").VLiteral<"retire", "required">], "required", never>;
        /** The last index key processed (all fields of the scanned index). */
        after: import("convex/values").VUnion<string[] | null, [import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    }, "required", "kind" | "after" | "phase">], "required", "entity" | "paths" | "rule" | "fact" | "kind" | "trigger" | "part" | "after" | "row" | "row.relation" | "row.subjectKey" | "row.objectKey" | "entity.type" | "entity.id" | "phase">, "required">;
    configHash: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    budget: import("convex/values").VFloat64<number, "required">;
    attempts: import("convex/values").VFloat64<number, "required">;
}, "required", "attempts" | "items" | "configHash" | "budget">;
export type Cursor = Infer<typeof vCursor>;
/** What a transaction runs under: the config (null: removal only) and its budget. */
export interface Env {
    config: GraphConfig | null;
    configHash: string | null;
    /** Budget units for this transaction (EXPANSION.md §5). */
    budget: number;
}
export interface Stats {
    factsDeleted: number;
    rowsDeleted: number;
}
export declare function findFact(ctx: MutationCtx, subject: Entity, relation: string, object: Entity): Promise<{
    _id: import("convex/values").GenericId<"relationships">;
    _creationTime: number;
    properties?: any;
    tenantId?: string | undefined;
    condition?: string | undefined;
    conditionContext?: any;
    subjectType: string;
    relation: string;
    objectType: string;
    objectId: string;
    subjectId: string;
} | null>;
export declare function findRow(ctx: MutationCtx, key: RowKey): Promise<{
    _id: import("convex/values").GenericId<"effectiveRelationships">;
    _creationTime: number;
    tenantId?: string | undefined;
    relation: string;
    paths: {
        rule?: string | undefined;
        conditions?: {
            conditionContext?: any;
            condition: string;
        }[] | undefined;
        baseIds: string[];
    }[];
    subjectKey: string;
    objectKey: string;
} | null>;
/**
 * Make `([f], 'fact')` a path of f's mirror row, with its lineage row
 * (CONTRACT §1, EXPANSION.md I3). Nothing dominates a mirror and no cap
 * applies to it; an untagged v1 mirror `[f]` is replaced, and every stored
 * superset of `[f]` is pruned, each charged `1 + |σ|` to `budget` when one is
 * given (at most the row's `MAX_PATHS + 1` paths; a fact just inserted has
 * none, since no stored path names a new id). Returns true when the path was
 * stored now (false: already there, its lineage row ensured).
 */
export declare function ensureMirror(ctx: MutationCtx, fact: Fact, budget?: Budget): Promise<boolean>;
/** Delete a row and the lineage rows of every one of its paths (maintenance's direct delete). */
export declare function deleteRow(ctx: MutationCtx, row: Row): Promise<void>;
/**
 * The units one transaction may spend (EXPANSION.md §5), shared by all its
 * steps. Until the transaction has made progress (processed an entry or
 * finished an item) every check passes, so every chunk progresses (P4). A
 * failed check sets `stopped`: the transaction ends at the next step
 * boundary. `spawned` holds the items the current step owes; `execute`
 * takes them after each step.
 */
declare class Budget {
    private readonly allowance;
    spent: number;
    stopped: boolean;
    private progressed;
    private spawned;
    constructor(allowance: number);
    get room(): number;
    fits(cost: number): boolean;
    charge(cost: number): void;
    /** Start an entry costing `cost` (it may charge more as it writes). */
    enter(cost: number): void;
    /** An item finished (progress, like an entry). */
    finished(): void;
    spawn(items: WorkItem[]): void;
    get spawning(): boolean;
    take(): WorkItem[];
}
/**
 * Run the pending list `items` in this transaction under `env.budget` units
 * (`ENQUEUE_UNITS` of them reserved for the one continuation), depth-first:
 * the head item runs; the items its last entry spawned go to the FRONT,
 * ahead of the head's own remainder. Returns what is left (head first), for
 * the caller to enqueue as ONE continuation (I5); its length is bounded by
 * the schema (EXPANSION.md Lemma B). The transaction's first entry always
 * runs (P4).
 */
export declare function execute(ctx: MutationCtx, env: Env, items: WorkItem[]): Promise<{
    rest: WorkItem[];
    stats: Stats;
}>;
/**
 * Read a continuation payload (CONTRACT §5.3) defensively: it was written by
 * the engine version that enqueued it. The envelope of the previous version,
 * `{ item, … }`, is read as `{ items: [item], … }`. An item that is not a
 * work item of this version is dropped with a warning (EXPANSION.md Lemma Q:
 * the active config's `rebuild` re-derives everything). Null when the
 * envelope itself is unreadable.
 */
export declare function parseCursor(payload: unknown): Cursor | null;
/**
 * Insert the fact and its mirror (with its lineage row); return the mirror's
 * items (to `execute`). Idempotent: an existing fact only has its
 * `properties` patched.
 */
export declare function insertFact(ctx: MutationCtx, env: Env, args: {
    subject: Entity;
    relation: string;
    object: Entity;
    properties?: unknown;
}): Promise<{
    id: Id<"relationships">;
    items: WorkItem[];
}>;
/**
 * Delete the fact and drop, from its mirror row, every path naming it (a v1
 * path without lineage included); return the removal item `remove(f)` (to
 * `execute`), which finds every other path naming f through `lineage`.
 */
export declare function deleteFact(ctx: MutationCtx, fact: Fact): Promise<{
    items: WorkItem[];
    rowDeleted: boolean;
}>;
export {};
//# sourceMappingURL=expand.d.ts.map