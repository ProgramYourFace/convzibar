import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";

/**
 * The pool that runs expansion continuations (EXPANSION.md §2.8). It only
 * runs mutations, which the workpool never retries itself: a failed chunk is
 * retried by `chunkCompleted` with half its budget (P4).
 */
export const expansionPool = new Workpool(components.workpool, {
  // One chunk at a time. Chunks of different chains touch the same rows (a
  // rebuild and a removal over one system), and two running at once only
  // retry each other under OCC with back-off (measured on the dev cell:
  // 35 s between chunks instead of ~4 s). Serial chunks keep every proof in
  // EXPANSION.md about "the facts now" trivially true and the pool cheap.
  maxParallelism: 1,
});
