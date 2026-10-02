/**
 * Compiled-config storage and defaults. The client compiles its schema into a
 * `GraphConfig` once and identifies it by a stable content hash. Mutations
 * ship only that hash (plus the full config on first use, to register it)
 * instead of re-serialising the entire rule set into every call, every
 * workpool chunk, and every onComplete payload.
 *
 * Pure of server imports: the client (`lib/zbar`) and the compiler import the
 * defaults from here.
 */
import type { GraphConfig } from "./types";
/** CONTRACT §6 defaults, applied when a config omits them. One home. */
export declare const DEFAULT_WRITE_BUDGET = 1000;
export declare const DEFAULT_MAX_DEPTH = 16;
/** The write-time limits of a config, with the CONTRACT §6 defaults. */
export declare function limitsOf(config: GraphConfig | null): {
    writeBudget: number;
    maxDepth: number;
};
/**
 * Stable marker embedded in the unregistered-config error. The client matches
 * on it to fall back to resending the full config when its local
 * "already registered" belief turns out to be stale (e.g. the registering
 * transaction rolled back after the client flipped its flag, or component
 * data was wiped/restored while a warm isolate still held the instance).
 */
export declare const CONFIG_UNREGISTERED_MARKER = "[convzibar:config-unregistered]";
/** Insert a compiled config keyed by `hash` if not already present (idempotent). */
export declare function ensureConfig(ctx: any, hash: string, config: GraphConfig): Promise<void>;
/** The active config's hash (EXPANSION.md §1.1), or null before any write. */
export declare function activeConfigHash(ctx: any): Promise<string | null>;
/**
 * Make `hash` the active config (EXPANSION.md §2.9, Lemma Q). Returns true
 * when a `rebuild` under it is owed, which the caller enqueues in the same
 * transaction: another hash was active (a deploy, or a rollback to an
 * earlier config), or no hash was recorded while facts exist (rows written
 * before the active row existed). A fresh component (no active row, no
 * fact) owes nothing.
 */
export declare function activateConfig(ctx: any, hash: string): Promise<boolean>;
/** Resolve a registered config by hash. Throws (with the marker) if the hash is unknown. */
export declare function loadConfig(ctx: any, hash: string): Promise<GraphConfig>;
//# sourceMappingURL=config.d.ts.map