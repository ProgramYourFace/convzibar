import { Workpool } from "@convex-dev/workpool";
/**
 * The pool that runs expansion continuations (EXPANSION.md §2.8). It only
 * runs mutations, which the workpool never retries itself: a failed chunk is
 * retried by `chunkCompleted` with half its budget (P4).
 */
export declare const expansionPool: Workpool;
//# sourceMappingURL=workpool.d.ts.map