import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { GraphConfig } from "../component/types";
import type { ZbarSchema } from "./types";
export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
export type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
export interface ZbarInternal {
    component: any;
    schema: ZbarSchema;
    /** The compiled config (v2). Both the planner and the BFS read only this. */
    graphConfig: GraphConfig;
    /** Stable content hash of `graphConfig`; mutations ship this instead of the config. */
    configHash: string;
}
//# sourceMappingURL=internal.d.ts.map