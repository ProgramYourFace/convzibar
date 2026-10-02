import type { ActionCtx, QueryCtx } from "../internal";
import { BaseListBuilder } from "../list/base";
import type { DirectRelationship } from "./types";
/**
 * Internal implementation of the fluent direct-relationship query builder.
 *
 * `listDirect()` returns FACTS, never reach (CONTRACT §3). A `.relation(r)` or
 * `.permission(p)` filter reads the writable members of the set's inherits
 * closure (`factRelations`). A set with inverse arms (`~T#r`) has no facts of
 * its own; its members are facts `(o, r, x)` read backwards, so they are
 * returned flipped: `{ subject: x, relation: <the set>, object: o }`, with the
 * underlying fact's properties.
 */
export declare class ListDirectQueryBuilder extends BaseListBuilder<DirectRelationship> {
    collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]>;
}
//# sourceMappingURL=builder.d.ts.map