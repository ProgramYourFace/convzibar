import type { ActionCtx, QueryCtx } from "../internal";
import { BaseListBuilder } from "./base";
type ListResult = {
    objectId: string;
} | {
    subjectId: string;
};
/**
 * Internal implementation of the fluent list query builder. A single class
 * implements all builder interfaces; the TypeScript interfaces (in ./types.ts)
 * restrict which methods are visible at each step.
 *
 * A relation and a permission compile the same way (`planSet`): both are sets
 * of arms, the permission merely unwritable.
 */
export declare class ListQueryBuilder extends BaseListBuilder<ListResult> {
    private _via;
    private _mode;
    object(objectOrType: string | {
        type: string;
        id: string;
    }): this;
    via(...entities: ({
        type: string;
        id: string;
    } | null | undefined)[]): this;
    collect(ctx: QueryCtx | ActionCtx): Promise<ListResult[]>;
}
export {};
//# sourceMappingURL=builder.d.ts.map