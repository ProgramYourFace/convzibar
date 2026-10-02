declare const _default: import("convex/server").SchemaDefinition<{
    /**
     * Facts (CONTRACT.md §1). Indexed from both ends so a first hop, an inverse
     * arm and an object-side `listDirect` are each one exact range.
     */
    relationships: import("convex/server").TableDefinition<import("convex/values").VObject<{
        properties?: any;
        tenantId?: string | undefined;
        condition?: string | undefined;
        conditionContext?: any;
        subjectType: string;
        relation: string;
        objectType: string;
        objectId: string;
        subjectId: string;
    }, {
        tenantId: import("convex/values").VString<string | undefined, "optional">;
        subjectType: import("convex/values").VString<string, "required">;
        subjectId: import("convex/values").VString<string, "required">;
        relation: import("convex/values").VString<string, "required">;
        objectType: import("convex/values").VString<string, "required">;
        objectId: import("convex/values").VString<string, "required">;
        condition: import("convex/values").VString<string | undefined, "optional">;
        conditionContext: import("convex/values").VAny<any, "optional", string>;
        properties: import("convex/values").VAny<any, "optional", string>;
    }, "required", "properties" | "subjectType" | "relation" | "objectType" | "objectId" | "subjectId" | "tenantId" | "condition" | "conditionContext" | `properties.${string}` | `conditionContext.${string}`>, {
        by_subject_relation_object: ["subjectType", "subjectId", "relation", "objectType", "objectId", "_creationTime"];
        by_object_relation_subject: ["objectType", "objectId", "relation", "subjectType", "subjectId", "_creationTime"];
    }, {}, {}>;
    /**
     * The mirror of every fact plus every materialized derivation
     * (CONTRACT.md §5). `paths` is the row's lineages (at most `MAX_PATHS`,
     * none a superset of another): a row exists iff it has a path. `rule` is
     * the TraversalRule key that produced the path, or `'fact'` for a mirror,
     * so `rebuild` can retire the paths of rules that no longer exist.
     */
    effectiveRelationships: import("convex/server").TableDefinition<import("convex/values").VObject<{
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
    }, {
        tenantId: import("convex/values").VString<string | undefined, "optional">;
        subjectKey: import("convex/values").VString<string, "required">;
        relation: import("convex/values").VString<string, "required">;
        objectKey: import("convex/values").VString<string, "required">;
        paths: import("convex/values").VArray<{
            rule?: string | undefined;
            conditions?: {
                conditionContext?: any;
                condition: string;
            }[] | undefined;
            baseIds: string[];
        }[], import("convex/values").VObject<{
            rule?: string | undefined;
            conditions?: {
                conditionContext?: any;
                condition: string;
            }[] | undefined;
            baseIds: string[];
        }, {
            baseIds: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
            rule: import("convex/values").VString<string | undefined, "optional">;
            conditions: import("convex/values").VArray<{
                conditionContext?: any;
                condition: string;
            }[] | undefined, import("convex/values").VObject<{
                conditionContext?: any;
                condition: string;
            }, {
                condition: import("convex/values").VString<string, "required">;
                conditionContext: import("convex/values").VAny<any, "optional", string>;
            }, "required", "condition" | "conditionContext" | `conditionContext.${string}`>, "optional">;
        }, "required", "baseIds" | "rule" | "conditions">, "required">;
    }, "required", "relation" | "paths" | "tenantId" | "subjectKey" | "objectKey">, {
        by_subject_relation_object: ["subjectKey", "relation", "objectKey", "_creationTime"];
        by_object_relation_subject: ["objectKey", "relation", "subjectKey", "_creationTime"];
    }, {}, {}>;
    /**
     * Invariant L (EXPANSION.md §1.4): exactly one row per (fact f, effective
     * row, stored path p) with f ∈ p.baseIds, written and deleted in the same
     * transaction as the path. `path` is `pathId(p)` (paths.ts). Removal of f is
     * one range over `by_fact` (CONTRACT §5.5); `by_row` finds the lineage rows
     * of one path when it is dropped.
     */
    lineage: import("convex/server").TableDefinition<import("convex/values").VObject<{
        factId: string;
        rowId: import("convex/values").GenericId<"effectiveRelationships">;
        path: string;
    }, {
        factId: import("convex/values").VString<string, "required">;
        rowId: import("convex/values").VId<import("convex/values").GenericId<"effectiveRelationships">, "required">;
        path: import("convex/values").VString<string, "required">;
    }, "required", "factId" | "rowId" | "path">, {
        by_fact: ["factId", "rowId", "path", "_creationTime"];
        by_row: ["rowId", "path", "factId", "_creationTime"];
    }, {}, {}>;
    /**
     * A continuation that gave up (CONTRACT.md §5.7), a derivation past
     * `maxDepth` (§5.2), or a path a full row could not take (`paths`, §5.2).
     * For `failed`/`canceled`, `cursor` is the exact continuation payload, so
     * `resumeExpansion` re-enqueues it unchanged; `depth` and `paths` are
     * repaired by `rebuild`.
     */
    expansionFailures: import("convex/server").TableDefinition<import("convex/values").VObject<{
        reason: "failed" | "canceled" | "depth" | "paths";
        cursor: any;
        error: string;
        attempts: number;
        createdAt: number;
    }, {
        cursor: import("convex/values").VAny<any, "required", string>;
        reason: import("convex/values").VUnion<"failed" | "canceled" | "depth" | "paths", [import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"canceled", "required">, import("convex/values").VLiteral<"depth", "required">, import("convex/values").VLiteral<"paths", "required">], "required", never>;
        error: import("convex/values").VString<string, "required">;
        attempts: import("convex/values").VFloat64<number, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "reason" | "cursor" | "error" | "attempts" | "createdAt" | `cursor.${string}`>, {
        by_createdAt: ["createdAt", "_creationTime"];
    }, {}, {}>;
    auditLog: import("convex/server").TableDefinition<import("convex/values").VObject<{
        tenantId?: string | undefined;
        actorId?: string | undefined;
        timestamp: number;
        action: "permission_check" | "relation_added" | "relation_removed";
        userId: string;
        details: {
            object?: string | undefined;
            relation?: string | undefined;
            reason?: string | undefined;
            permission?: string | undefined;
            subject?: string | undefined;
            result?: boolean | undefined;
        };
    }, {
        tenantId: import("convex/values").VString<string | undefined, "optional">;
        timestamp: import("convex/values").VFloat64<number, "required">;
        action: import("convex/values").VUnion<"permission_check" | "relation_added" | "relation_removed", [import("convex/values").VLiteral<"permission_check", "required">, import("convex/values").VLiteral<"relation_added", "required">, import("convex/values").VLiteral<"relation_removed", "required">], "required", never>;
        userId: import("convex/values").VString<string, "required">;
        actorId: import("convex/values").VString<string | undefined, "optional">;
        details: import("convex/values").VObject<{
            object?: string | undefined;
            relation?: string | undefined;
            reason?: string | undefined;
            permission?: string | undefined;
            subject?: string | undefined;
            result?: boolean | undefined;
        }, {
            permission: import("convex/values").VString<string | undefined, "optional">;
            result: import("convex/values").VBoolean<boolean | undefined, "optional">;
            relation: import("convex/values").VString<string | undefined, "optional">;
            subject: import("convex/values").VString<string | undefined, "optional">;
            object: import("convex/values").VString<string | undefined, "optional">;
            reason: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "object" | "relation" | "reason" | "permission" | "subject" | "result">;
    }, "required", "tenantId" | "timestamp" | "action" | "userId" | "actorId" | "details" | "details.object" | "details.relation" | "details.reason" | "details.permission" | "details.subject" | "details.result">, {}, {}, {}>;
    configs: import("convex/server").TableDefinition<import("convex/values").VObject<{
        hash: string;
        config: any;
    }, {
        hash: import("convex/values").VString<string, "required">;
        config: import("convex/values").VAny<any, "required", string>;
    }, "required", "hash" | "config" | `config.${string}`>, {
        by_hash: ["hash", "_creationTime"];
    }, {}, {}>;
    /**
     * At most one row: the hash of the ACTIVE config (EXPANSION.md §1.1,
     * Lemma Q). A write under another hash makes it active and enqueues a
     * `rebuild` under it; add and rebuild cursors of any other hash are dropped.
     */
    activeConfig: import("convex/server").TableDefinition<import("convex/values").VObject<{
        hash: string;
    }, {
        hash: import("convex/values").VString<string, "required">;
    }, "required", "hash">, {}, {}, {}>;
}, true>;
export default _default;
//# sourceMappingURL=schema.d.ts.map