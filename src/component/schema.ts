import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ============================================================================
// TRANSITIONAL v1 COMPATIBILITY (remove after data cleanup)
//
// v1 rows carry fields the engine no longer reads or writes: `tenantId`
// (multi-tenancy), `condition`/`conditionContext` and per-path `conditions`
// (ABAC), and an `auditLog` table. Convex schema validation runs against
// existing documents on deploy, so v2 must still *declare* those shapes for
// an in-place upgrade of a v1 deployment to succeed. Nothing reads them; new
// rows never contain them. Once the deployment's rows have been rewritten
// (or the graph re-provisioned) these declarations can be deleted.
// ============================================================================

/** @deprecated v1 leftover — never read or written by v2. */
const legacyTenantId = v.optional(v.string());
/** @deprecated v1 ABAC leftovers — never read or written by v2. */
const legacyCondition = v.optional(v.string());
const legacyConditionContext = v.optional(v.any());

const schema = {
  /**
   * Facts (CONTRACT.md §1). Indexed from both ends so a first hop, an inverse
   * arm and an object-side `listDirect` are each one exact range.
   */
  relationships: defineTable({
    tenantId: legacyTenantId,
    subjectType: v.string(),
    subjectId: v.string(),
    relation: v.string(),
    objectType: v.string(),
    objectId: v.string(),
    condition: legacyCondition,
    conditionContext: legacyConditionContext,
    properties: v.optional(v.any()), // user-defined edge properties
  })
    .index("by_subject_relation_object", [
      "subjectType",
      "subjectId",
      "relation",
      "objectType",
      "objectId",
    ])
    .index("by_object_relation_subject", [
      "objectType",
      "objectId",
      "relation",
      "subjectType",
      "subjectId",
    ]),

  /**
   * The mirror of every fact plus every materialized derivation
   * (CONTRACT.md §5). `paths` is the row's lineages (at most `MAX_PATHS`,
   * none a superset of another): a row exists iff it has a path. `rule` is
   * the TraversalRule key that produced the path, or `'fact'` for a mirror,
   * so `rebuild` can retire the paths of rules that no longer exist.
   */
  effectiveRelationships: defineTable({
    tenantId: legacyTenantId,
    subjectKey: v.string(), // `${subjectType}:${subjectId}`
    relation: v.string(),
    objectKey: v.string(), // `${objectType}:${objectId}`
    paths: v.array(
      v.object({
        baseIds: v.array(v.string()),
        // Optional only for rows written before v2; the BFS always writes it.
        rule: v.optional(v.string()),
        conditions: v.optional(
          v.array(
            v.object({
              condition: v.string(),
              conditionContext: v.optional(v.any()),
            }),
          ),
        ), // @deprecated v1 leftover
      }),
    ),
  })
    .index("by_subject_relation_object", [
      "subjectKey",
      "relation",
      "objectKey",
    ])
    .index("by_object_relation_subject", [
      "objectKey",
      "relation",
      "subjectKey",
    ]),

  /**
   * Invariant L (EXPANSION.md §1.4): exactly one row per (fact f, effective
   * row, stored path p) with f ∈ p.baseIds, written and deleted in the same
   * transaction as the path. `path` is `pathId(p)` (paths.ts). Removal of f is
   * one range over `by_fact` (CONTRACT §5.5); `by_row` finds the lineage rows
   * of one path when it is dropped.
   */
  lineage: defineTable({
    factId: v.string(),
    rowId: v.id("effectiveRelationships"),
    path: v.string(),
  })
    .index("by_fact", ["factId", "rowId", "path"])
    .index("by_row", ["rowId", "path", "factId"]),

  /**
   * A continuation that gave up (CONTRACT.md §5.7), a derivation past
   * `maxDepth` (§5.2), or a path a full row could not take (`paths`, §5.2).
   * For `failed`/`canceled`, `cursor` is the exact continuation payload, so
   * `resumeExpansion` re-enqueues it unchanged; `depth` and `paths` are
   * repaired by `rebuild`.
   */
  expansionFailures: defineTable({
    cursor: v.any(),
    reason: v.union(
      v.literal("failed"),
      v.literal("canceled"),
      v.literal("depth"),
      v.literal("paths"),
    ),
    error: v.string(),
    attempts: v.number(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  // @deprecated v1 leftover, kept only so deployments with historical audit
  // rows pass schema validation. The engine never writes to it. Clear the
  // table and delete this block whenever convenient.
  auditLog: defineTable({
    tenantId: legacyTenantId,
    timestamp: v.number(),
    action: v.union(
      v.literal("permission_check"),
      v.literal("relation_added"),
      v.literal("relation_removed"),
    ),
    userId: v.string(),
    actorId: v.optional(v.string()),
    details: v.object({
      permission: v.optional(v.string()),
      result: v.optional(v.boolean()),
      relation: v.optional(v.string()),
      subject: v.optional(v.string()),
      object: v.optional(v.string()),
      reason: v.optional(v.string()),
    }),
  }),

  // Compiled graph configuration, stored once and referenced by a stable
  // content hash so mutations ship only the hash instead of the full rule set.
  configs: defineTable({
    hash: v.string(),
    config: v.any(), // GraphConfig
  }).index("by_hash", ["hash"]),

  /**
   * At most one row: the hash of the ACTIVE config (EXPANSION.md §1.1,
   * Lemma Q). A write under another hash makes it active and enqueues a
   * `rebuild` under it; add and rebuild cursors of any other hash are dropped.
   */
  activeConfig: defineTable({
    hash: v.string(),
  }),
};

// ============================================================================
// Test-Time Only Schema
// ============================================================================

// The mockWorkpool table is strictly used for testing async worker logic
// locally. It is intentionally stripped from production schemas.
if (process.env.NODE_ENV === "test") {
  (schema as any).mockWorkpool = defineTable({
    mutationName: v.string(),
    args: v.any(),
  });
}

export default defineSchema(schema);
