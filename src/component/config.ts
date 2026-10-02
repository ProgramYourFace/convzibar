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
export const DEFAULT_WRITE_BUDGET = 1000;
export const DEFAULT_MAX_DEPTH = 16;

/** The write-time limits of a config, with the CONTRACT §6 defaults. */
export function limitsOf(config: GraphConfig | null): {
  writeBudget: number;
  maxDepth: number;
} {
  return {
    writeBudget: Math.max(1, config?.writeBudget ?? DEFAULT_WRITE_BUDGET),
    maxDepth: config?.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
}

/**
 * Stable marker embedded in the unregistered-config error. The client matches
 * on it to fall back to resending the full config when its local
 * "already registered" belief turns out to be stale (e.g. the registering
 * transaction rolled back after the client flipped its flag, or component
 * data was wiped/restored while a warm isolate still held the instance).
 */
export const CONFIG_UNREGISTERED_MARKER = "[convzibar:config-unregistered]";

async function findConfig(ctx: any, hash: string) {
  return await ctx.db
    .query("configs")
    .withIndex("by_hash", (q: any) => q.eq("hash", hash))
    .unique();
}

/** Insert a compiled config keyed by `hash` if not already present (idempotent). */
export async function ensureConfig(
  ctx: any,
  hash: string,
  config: GraphConfig,
): Promise<void> {
  if (!(await findConfig(ctx, hash)))
    await ctx.db.insert("configs", { hash, config });
}

/** The active config's hash (EXPANSION.md §1.1), or null before any write. */
export async function activeConfigHash(ctx: any): Promise<string | null> {
  const row = await ctx.db.query("activeConfig").first();
  return row?.hash ?? null;
}

/**
 * Make `hash` the active config (EXPANSION.md §2.9, Lemma Q). Returns true
 * when a `rebuild` under it is owed, which the caller enqueues in the same
 * transaction: another hash was active (a deploy, or a rollback to an
 * earlier config), or no hash was recorded while facts exist (rows written
 * before the active row existed). A fresh component (no active row, no
 * fact) owes nothing.
 */
export async function activateConfig(ctx: any, hash: string): Promise<boolean> {
  const active = await ctx.db.query("activeConfig").first();
  if (active?.hash === hash) return false;
  if (active) {
    await ctx.db.patch(active._id, { hash });
    return true;
  }
  await ctx.db.insert("activeConfig", { hash });
  return (await ctx.db.query("relationships").first()) !== null;
}

/** Resolve a registered config by hash. Throws (with the marker) if the hash is unknown. */
export async function loadConfig(ctx: any, hash: string): Promise<GraphConfig> {
  const row = await findConfig(ctx, hash);
  if (!row) {
    throw new Error(
      `Zbar: graph config '${hash}' is not registered. ${CONFIG_UNREGISTERED_MARKER} ` +
        `The first mutation from a Zbar client registers it automatically.`,
    );
  }
  return row.config as GraphConfig;
}
