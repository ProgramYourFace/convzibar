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

import { validate } from "convex-helpers/validators";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { limitsOf } from "./config";
import { buildScopeKey, decodeScopeKey } from "../shared/keys";
import {
  FACT_RULE,
  MAX_PATHS,
  canonicalizePath,
  mergePath,
  pathId,
  pathSize,
} from "./paths";
import type { EffectivePath, GraphConfig, TraversalRule } from "./types";

type Fact = Doc<"relationships">;
type Row = Doc<"effectiveRelationships">;
type Entity = { type: string; id: string };
type StoredPath = Row["paths"][number];

// ---------------------------------------------------------------------------
// Work items and cursors (EXPANSION.md I4: plain data, nothing else).
// ---------------------------------------------------------------------------

const vRowKey = v.object({
  subjectKey: v.string(),
  relation: v.string(),
  objectKey: v.string(),
});
type RowKey = Infer<typeof vRowKey>;

const vAfter = v.union(v.string(), v.null());

const vWorkItem = v.union(
  v.object({
    kind: v.literal("add"),
    trigger: v.literal("first"),
    fact: v.id("relationships"),
    rule: v.string(),
    /** Index into `[...secondHop.relations, ...secondHop.inverses]`. */
    part: v.number(),
    after: vAfter,
  }),
  v.object({
    kind: v.literal("add"),
    trigger: v.literal("inverse"),
    fact: v.id("relationships"),
    rule: v.string(),
    after: vAfter,
  }),
  v.object({
    kind: v.literal("add"),
    trigger: v.literal("second"),
    row: vRowKey,
    rule: v.string(),
    /** The `pathId`s of the paths whose store owes this item: it derives from these only (§2.5). */
    paths: v.array(v.string()),
    after: vAfter,
  }),
  /** Every lineage row of a deleted fact; the range is re-read from its start (processed entries leave it). */
  v.object({ kind: v.literal("remove"), fact: v.string() }),
  v.object({
    kind: v.literal("deleteEntity"),
    entity: v.object({ type: v.string(), id: v.string() }),
  }),
  v.object({
    kind: v.literal("rebuild"),
    phase: v.union(v.literal("derive"), v.literal("retire")),
    /** The last index key processed (all fields of the scanned index). */
    after: v.union(v.array(v.string()), v.null()),
  }),
);
export type WorkItem = Infer<typeof vWorkItem>;

/**
 * The continuation payload handed to the workpool (CONTRACT §5.3): the
 * unfinished part of one transaction's pending list, head first (each
 * in-progress item carries its own cursor), bounded by the schema (EXPANSION.md
 * Lemma B). `configHash` is null for config-free work (a removal started by
 * maintenance): removal reads no rule (CONTRACT §5.5).
 */
export const vCursor = v.object({
  items: v.array(vWorkItem),
  configHash: v.union(v.string(), v.null()),
  budget: v.number(),
  attempts: v.number(),
});
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

/** Units reserved for the transaction's one continuation enqueue (EXPANSION.md §5). */
const ENQUEUE_UNITS = 2;
/** The first page of a `scan` call; each full page doubles the next (EXPANSION.md §2.6). */
const FIRST_PAGE = 2;
/** The most entries one index fetch reads. */
const PAGE_MAX = 256;

// ---------------------------------------------------------------------------
// Keys and point reads.
// ---------------------------------------------------------------------------

const join = (...parts: string[]) => parts.join("\u0000");

/** The mirror path of a fact (CONTRACT §1, EXPANSION.md I3). */
const mirrorPathOf = (id: Id<"relationships">): EffectivePath => ({
  baseIds: [id],
  rule: FACT_RULE,
});

/** The mirror row key of a fact (CONTRACT §1): the same triple. */
function mirrorKeyOf(f: {
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
}): RowKey {
  return {
    subjectKey: buildScopeKey(f.subjectType, f.subjectId),
    relation: f.relation,
    objectKey: buildScopeKey(f.objectType, f.objectId),
  };
}

export async function findFact(
  ctx: MutationCtx,
  subject: Entity,
  relation: string,
  object: Entity,
) {
  return await ctx.db
    .query("relationships")
    .withIndex("by_subject_relation_object", (q) =>
      q
        .eq("subjectType", subject.type)
        .eq("subjectId", subject.id)
        .eq("relation", relation)
        .eq("objectType", object.type)
        .eq("objectId", object.id),
    )
    .unique();
}

export async function findRow(ctx: MutationCtx, key: RowKey) {
  return await ctx.db
    .query("effectiveRelationships")
    .withIndex("by_subject_relation_object", (q) =>
      q
        .eq("subjectKey", key.subjectKey)
        .eq("relation", key.relation)
        .eq("objectKey", key.objectKey),
    )
    .unique();
}

/** Whether the fact with this id exists now (any string: a v1 or foreign id is simply absent). */
async function factExists(ctx: MutationCtx, id: string): Promise<boolean> {
  const normalized = ctx.db.normalizeId("relationships", id);
  return normalized !== null && (await ctx.db.get(normalized)) !== null;
}

// ---------------------------------------------------------------------------
// 2.1 ruleIndex
// ---------------------------------------------------------------------------

interface RuleIndex {
  byKey: Map<string, TraversalRule>;
  /** (objectType, firstHop.relation, intermediateType) */
  firstHop: Map<string, TraversalRule[]>;
  /** (intermediateType, r) for r ∈ secondHop.relations */
  secondHop: Map<string, TraversalRule[]>;
  /** (intermediateType, inverse.subjectType, inverse.relation) */
  inverse: Map<string, TraversalRule[]>;
}

const indexCache = new WeakMap<GraphConfig, RuleIndex>();

function ruleIndex(config: GraphConfig): RuleIndex {
  const cached = indexCache.get(config);
  if (cached) return cached;
  const idx: RuleIndex = {
    byKey: new Map(),
    firstHop: new Map(),
    secondHop: new Map(),
    inverse: new Map(),
  };
  const add = (
    map: Map<string, TraversalRule[]>,
    key: string,
    rule: TraversalRule,
  ) => {
    const list = map.get(key);
    if (!list) map.set(key, [rule]);
    else if (!list.includes(rule)) list.push(rule);
  };
  for (const rule of config.rules ?? []) {
    idx.byKey.set(rule.key, rule);
    add(
      idx.firstHop,
      join(
        rule.objectType,
        rule.firstHop.relation,
        rule.firstHop.intermediateType,
      ),
      rule,
    );
    for (const r of rule.secondHop.relations) {
      add(idx.secondHop, join(rule.firstHop.intermediateType, r), rule);
    }
    for (const inv of rule.secondHop.inverses) {
      add(
        idx.inverse,
        join(rule.firstHop.intermediateType, inv.subjectType, inv.relation),
        rule,
      );
    }
  }
  indexCache.set(config, idx);
  return idx;
}

const rulesAt = (map: Map<string, TraversalRule[]>, key: string) =>
  map.get(key) ?? [];

function configOf(env: Env): GraphConfig {
  if (!env.config)
    throw new Error(
      "convzibar: this work item needs a config, and its cursor has none.",
    );
  return env.config;
}

function ruleOf(env: Env, key: string): TraversalRule {
  const rule = ruleIndex(configOf(env)).byKey.get(key);
  if (!rule)
    throw new Error(
      `Zbar: rule '${key}' is not in config '${env.configHash}'.`,
    );
  return rule;
}

/**
 * A path is current under the config when it is a mirror, or names a rule of
 * the config and has at most its `maxDepth` facts (EXPANSION.md §1.1; paths.ts
 * `mergePath`). `rebuild/retire` drops exactly the paths that are not.
 */
function isCurrent(env: Env) {
  const keys = env.config ? ruleIndex(env.config).byKey : new Map();
  const { maxDepth } = limitsOf(env.config);
  return (p: { baseIds: readonly string[]; rule?: string }) =>
    p.rule === FACT_RULE ||
    (p.rule !== undefined && keys.has(p.rule) && p.baseIds.length <= maxDepth);
}

// ---------------------------------------------------------------------------
// 2.2 derive
// ---------------------------------------------------------------------------

/**
 * `fact (m, ρ.h, o)` + second hop `(x, lineage)` ⇒ row `(x, ρ.d, o)` with
 * path `{f} ∪ lineage`, tagged with the rule key. The second hop is a row's
 * subject and one of its paths, or an inverse fact's object and `[g]`.
 */
function derive(
  rule: TraversalRule,
  firstHop: Fact,
  secondHop: { subjectKey: string; baseIds: readonly string[] },
): { row: RowKey; path: EffectivePath } {
  return {
    row: {
      subjectKey: secondHop.subjectKey,
      relation: rule.derived,
      objectKey: buildScopeKey(firstHop.objectType, firstHop.objectId),
    },
    path: canonicalizePath({
      baseIds: [firstHop._id, ...secondHop.baseIds],
      rule: rule.key,
    }),
  };
}

// ---------------------------------------------------------------------------
// 2.4 writePaths, ensureMirror, ensureLineage, dropPath, deleteRow — the only
// writers of `effectiveRelationships` paths and of `lineage` (Invariant L).
// ---------------------------------------------------------------------------

/** Insert the lineage rows of a path just stored on `rowId` (one per fact). */
async function addLineage(
  ctx: MutationCtx,
  rowId: Id<"effectiveRelationships">,
  path: StoredPath,
) {
  const id = pathId(path);
  for (const factId of path.baseIds)
    await ctx.db.insert("lineage", { factId, rowId, path: id });
}

/** Delete the lineage rows of one path of a row: by L, at most one per fact of the path. */
async function dropLineage(
  ctx: MutationCtx,
  rowId: Id<"effectiveRelationships">,
  path: string,
) {
  const rows = await ctx.db
    .query("lineage")
    .withIndex("by_row", (q) => q.eq("rowId", rowId).eq("path", path))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

async function recordFailure(
  ctx: MutationCtx,
  env: Env,
  reason: "depth" | "paths",
  row: RowKey,
  path: EffectivePath,
  error: string,
) {
  await ctx.db.insert("expansionFailures", {
    cursor: { kind: reason, row, path, configHash: env.configHash },
    reason,
    error,
    attempts: 0,
    createdAt: Date.now(),
  });
}

/**
 * Merge candidate paths (all for `key`) into the row, in order. For each
 * candidate π:
 *
 *   dominated by a current path            → skip
 *   |π| > maxDepth                         → `expansionFailures{depth}`, skip
 *   some fact of π absent now (Invariant W) → skip
 *   the row holds MAX_PATHS current paths  → `expansionFailures{paths}`, skip
 *   otherwise                              → prune the supersets of π and
 *                                            evict non-current paths over the
 *                                            cap (with their lineage), store
 *                                            π, write its lineage
 *
 * W is the point of the third line: a path is written only by a
 * transaction that read every one of its facts and found it present.
 * Charges `|π|` units per stored path and `1 + |σ|` per pruned or evicted path σ.
 * Returns the paths it stored (the row changed iff there is one); each owes
 * the row's second-hop items (§2.5).
 */
async function writePaths(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  key: RowKey,
  candidates: EffectivePath[],
): Promise<EffectivePath[]> {
  const { maxDepth } = limitsOf(env.config);
  const current = isCurrent(env);
  let doc: Row | null = await findRow(ctx, key);
  const stored: EffectivePath[] = [];
  for (const candidate of candidates) {
    const merged = mergePath(doc?.paths ?? [], candidate, current);
    if (merged.kind === "dominated") continue;
    const path = canonicalizePath(candidate);
    if (path.baseIds.length > maxDepth) {
      budget.charge(1);
      await recordFailure(
        ctx,
        env,
        "depth",
        key,
        path,
        `lineage of ${path.baseIds.length} facts exceeds maxDepth ${maxDepth}`,
      );
      continue;
    }
    budget.charge(path.baseIds.length);
    let live = true;
    for (const id of path.baseIds)
      if (!(await factExists(ctx, id))) live = false;
    if (!live) continue;
    if (merged.kind === "full") {
      budget.charge(1);
      await recordFailure(
        ctx,
        env,
        "paths",
        key,
        path,
        `row already holds ${MAX_PATHS} current paths; rebuild re-derives it if it is retracted early`,
      );
      continue;
    }
    if (doc) {
      for (const pruned of merged.pruned) {
        budget.charge(1 + pruned.baseIds.length);
        await dropLineage(ctx, doc._id, pathId(pruned));
      }
      await ctx.db.patch(doc._id, { paths: merged.paths as StoredPath[] });
      doc = { ...doc, paths: merged.paths as StoredPath[] };
    } else {
      const id = await ctx.db.insert("effectiveRelationships", {
        ...key,
        paths: [merged.path],
      });
      doc = (await ctx.db.get(id))!;
    }
    await addLineage(ctx, doc._id, merged.path);
    stored.push(merged.path);
  }
  return stored;
}

/**
 * Make `([f], 'fact')` a path of f's mirror row, with its lineage row
 * (CONTRACT §1, EXPANSION.md I3). Nothing dominates a mirror and no cap
 * applies to it; an untagged v1 mirror `[f]` is replaced, and every stored
 * superset of `[f]` is pruned, each charged `1 + |σ|` to `budget` when one is
 * given (at most the row's `MAX_PATHS + 1` paths; a fact just inserted has
 * none, since no stored path names a new id). Returns true when the path was
 * stored now (false: already there, its lineage row ensured).
 */
export async function ensureMirror(
  ctx: MutationCtx,
  fact: Fact,
  budget?: Budget,
): Promise<boolean> {
  const key = mirrorKeyOf(fact);
  const mirror = mirrorPathOf(fact._id);
  const id = pathId(mirror);
  const row = await findRow(ctx, key);
  if (row && row.paths.some((p) => pathId(p) === id && !p.conditions)) {
    const own = await ctx.db
      .query("lineage")
      .withIndex("by_row", (q) =>
        q.eq("rowId", row._id).eq("path", id).eq("factId", fact._id),
      )
      .unique();
    if (!own) await addLineage(ctx, row._id, mirror);
    return false;
  }
  const merged = mergePath(row?.paths ?? [], mirror, () => false, Infinity);
  if (merged.kind !== "stored")
    throw new Error("convzibar: a mirror is always stored");
  let rowId = row?._id;
  if (rowId) {
    for (const pruned of merged.pruned) {
      budget?.charge(1 + pruned.baseIds.length);
      await dropLineage(ctx, rowId, pathId(pruned));
    }
    await ctx.db.patch(rowId, { paths: merged.paths as StoredPath[] });
  } else {
    rowId = await ctx.db.insert("effectiveRelationships", {
      ...key,
      paths: [mirror],
    });
  }
  await addLineage(ctx, rowId, mirror);
  return true;
}

/**
 * Insert the lineage rows a kept path lacks (a path written before Invariant
 * L existed): one `by_row` lookup per fact (`rebuild/retire`).
 */
async function ensureLineage(
  ctx: MutationCtx,
  rowId: Id<"effectiveRelationships">,
  p: StoredPath,
) {
  const id = pathId(p);
  for (const factId of p.baseIds) {
    const existing = await ctx.db
      .query("lineage")
      .withIndex("by_row", (q) =>
        q.eq("rowId", rowId).eq("path", id).eq("factId", factId),
      )
      .unique();
    if (!existing) await ctx.db.insert("lineage", { factId, rowId, path: id });
  }
}

/**
 * Drop the path with id `path` from the row and delete its lineage rows;
 * delete the row when no path remains. The lineage rows go even when the
 * path is already gone, so a removal scan always makes progress.
 */
async function dropPath(
  ctx: MutationCtx,
  rowId: Id<"effectiveRelationships">,
  path: string,
): Promise<"unchanged" | "patched" | "deleted"> {
  await dropLineage(ctx, rowId, path);
  const row = await ctx.db.get(rowId);
  if (!row) return "unchanged";
  const paths = row.paths.filter((p) => pathId(p) !== path);
  if (paths.length === row.paths.length) return "unchanged";
  if (paths.length === 0) {
    await ctx.db.delete(rowId);
    return "deleted";
  }
  await ctx.db.patch(rowId, { paths });
  return "patched";
}

/** Delete a row and the lineage rows of every one of its paths (maintenance's direct delete). */
export async function deleteRow(ctx: MutationCtx, row: Row) {
  for (const p of row.paths) await dropLineage(ctx, row._id, pathId(p));
  await ctx.db.delete(row._id);
}

// ---------------------------------------------------------------------------
// 2.5 triggersOf
// ---------------------------------------------------------------------------

/**
 * The add items owed by a row `(x, r, y)` that just changed (CONTRACT §5.2):
 * when the change stored the mirror of fact `mirror`, its first-hop and
 * inverse items; for the paths `stored` (none: nothing), one second-hop item
 * per rule reading `r` on `type(y)`, which derives from those paths only.
 */
function triggersOf(
  config: GraphConfig,
  row: RowKey,
  mirror: Id<"relationships"> | null,
  stored: readonly EffectivePath[],
): WorkItem[] {
  const idx = ruleIndex(config);
  const [xType] = decodeScopeKey(row.subjectKey);
  const [yType] = decodeScopeKey(row.objectKey);
  const items: WorkItem[] = [];
  if (mirror) {
    for (const rule of rulesAt(
      idx.firstHop,
      join(yType, row.relation, xType),
    )) {
      items.push({
        kind: "add",
        trigger: "first",
        fact: mirror,
        rule: rule.key,
        part: 0,
        after: null,
      });
    }
    for (const rule of rulesAt(idx.inverse, join(xType, yType, row.relation))) {
      items.push({
        kind: "add",
        trigger: "inverse",
        fact: mirror,
        rule: rule.key,
        after: null,
      });
    }
  }
  if (stored.length > 0) {
    const paths = stored.map(pathId);
    for (const rule of rulesAt(idx.secondHop, join(yType, row.relation))) {
      items.push({
        kind: "add",
        trigger: "second",
        row,
        rule: rule.key,
        paths,
        after: null,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// 2.6 Budget, scan
// ---------------------------------------------------------------------------

/**
 * The units one transaction may spend (EXPANSION.md §5), shared by all its
 * steps. Until the transaction has made progress (processed an entry or
 * finished an item) every check passes, so every chunk progresses (P4). A
 * failed check sets `stopped`: the transaction ends at the next step
 * boundary. `spawned` holds the items the current step owes; `execute`
 * takes them after each step.
 */
class Budget {
  spent = 0;
  stopped = false;
  private progressed = false;
  private spawned: WorkItem[] = [];
  constructor(private readonly allowance: number) {}

  get room(): number {
    return this.allowance - this.spent;
  }
  fits(cost: number): boolean {
    if (!this.progressed || this.room >= cost) return true;
    this.stopped = true;
    return false;
  }
  charge(cost: number): void {
    this.spent += cost;
  }
  /** Start an entry costing `cost` (it may charge more as it writes). */
  enter(cost: number): void {
    this.progressed = true;
    this.spent += cost;
  }
  /** An item finished (progress, like an entry). */
  finished(): void {
    this.progressed = true;
  }
  spawn(items: WorkItem[]): void {
    this.spawned.push(...items);
  }
  get spawning(): boolean {
    return this.spawned.length > 0;
  }
  take(): WorkItem[] {
    const items = this.spawned;
    this.spawned = [];
    return items;
  }
}

/**
 * Iterate one index range in pages, strictly after the key `after`. Each
 * fetch costs 1 unit, each entry 1 unit plus what `process` charges. Pages
 * start at `FIRST_PAGE` entries and double while they are read whole (at most
 * `PAGE_MAX`, and the room left), so the entries a call fetches but does not
 * process are at most 2 plus those it processed (EXPANSION.md §5). Returns
 * after the first entry that spawned items (they run first, depth-first),
 * when the budget stops, or with `done` when the range is exhausted (a short
 * page read to its end). `after` is the key of the last processed entry.
 */
async function scan<T, K>(
  budget: Budget,
  after: K | null,
  fetch: (after: K | null, n: number) => Promise<T[]>,
  keyOf: (entry: T) => K,
  process: (entry: T) => Promise<void>,
): Promise<{ done: boolean; after: K | null }> {
  for (let size = FIRST_PAGE; ; size = Math.min(2 * size, PAGE_MAX)) {
    if (!budget.fits(2)) return { done: false, after };
    const n = Math.min(size, Math.max(1, budget.room - 1));
    budget.charge(1);
    const page = await fetch(after, n);
    for (let i = 0; i < page.length; i++) {
      if (!budget.fits(1)) return { done: false, after };
      budget.enter(1);
      await process(page[i]);
      after = keyOf(page[i]);
      if (budget.spawning)
        return { done: page.length < n && i === page.length - 1, after };
    }
    if (page.length < n) return { done: true, after: null };
  }
}

/** Facts `(subject, relation, objectType:*)` after `after`, by object id. */
const factRange =
  (ctx: MutationCtx, subject: Entity, relation: string, objectType: string) =>
  (after: string | null, n: number) =>
    ctx.db
      .query("relationships")
      .withIndex("by_subject_relation_object", (q) => {
        const b = q
          .eq("subjectType", subject.type)
          .eq("subjectId", subject.id)
          .eq("relation", relation)
          .eq("objectType", objectType);
        return after === null ? b : b.gt("objectId", after);
      })
      .take(n);

// ---------------------------------------------------------------------------
// 2.7 One step per work-item kind. Each runs its item under `budget` and
// returns the same item with its cursor advanced, or null when finished;
// what it owes is in `budget.spawned`. A step returns an unfinished item only
// (a) when the budget stopped, (b) right after an entry that spawned items
// (they run before the item's next entry), or (c) rebuild/derive handing
// over to rebuild/retire.
// ---------------------------------------------------------------------------

/** Write the candidates for `row`; spawn the second-hop items of the paths it stored. */
async function emit(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  row: RowKey,
  paths: EffectivePath[],
) {
  const stored = await writePaths(ctx, env, budget, row, paths);
  budget.spawn(triggersOf(configOf(env), row, null, stored));
}

type AddItem<T extends string> = Extract<WorkItem, { kind: "add"; trigger: T }>;

/**
 * add/first(f, ρ): the second hops of f's subject m — rows `(*, r', m)`, then
 * inverse facts `(m, q, *:T)`. Like every add step it derives only from
 * CURRENT paths (mirrors and this config's rules): a path another config
 * wrote is not a derivation this config vouches for (EXPANSION.md I1).
 */
async function stepAddFirst(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  item: AddItem<"first">,
) {
  const rule = ruleOf(env, item.rule);
  const current = isCurrent(env);
  budget.charge(1);
  const f = await ctx.db.get(item.fact);
  if (!f) return null; // removed: its removal covers whatever was written from it
  const m = { type: f.subjectType, id: f.subjectId };
  const mKey = buildScopeKey(m.type, m.id);
  const { relations, inverses } = rule.secondHop;
  let { part, after } = item;
  while (part < relations.length + inverses.length) {
    let res: { done: boolean; after: string | null };
    if (part < relations.length) {
      const r = relations[part];
      res = await scan(
        budget,
        after,
        (a, n) =>
          ctx.db
            .query("effectiveRelationships")
            .withIndex("by_object_relation_subject", (q) => {
              const b = q.eq("objectKey", mKey).eq("relation", r);
              return a === null ? b : b.gt("subjectKey", a);
            })
            .take(n),
        (e) => e.subjectKey,
        async (e) => {
          const paths = e.paths
            .filter((p) => current(p))
            .map(
              (p) =>
                derive(rule, f, {
                  subjectKey: e.subjectKey,
                  baseIds: p.baseIds,
                }).path,
            );
          await emit(
            ctx,
            env,
            budget,
            derive(rule, f, { subjectKey: e.subjectKey, baseIds: [] }).row,
            paths,
          );
        },
      );
    } else {
      const inv = inverses[part - relations.length];
      res = await scan(
        budget,
        after,
        factRange(ctx, m, inv.relation, inv.subjectType),
        (g) => g.objectId,
        async (g) => {
          const d = derive(rule, f, {
            subjectKey: buildScopeKey(g.objectType, g.objectId),
            baseIds: [g._id],
          });
          await emit(ctx, env, budget, d.row, [d.path]);
        },
      );
    }
    if (!res.done) return { ...item, part, after: res.after };
    part++;
    after = null;
    if (budget.spawning) break; // the spawned items run before the next part
  }
  return part < relations.length + inverses.length
    ? { ...item, part, after }
    : null;
}

/** add/inverse(g, ρ): the first-hop facts `(g.subject, ρ.h, *:ρ.O)`, each with second hop `[g]`. */
async function stepAddInverse(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  item: AddItem<"inverse">,
) {
  const rule = ruleOf(env, item.rule);
  budget.charge(1);
  const g = await ctx.db.get(item.fact);
  if (!g) return null;
  const second = {
    subjectKey: buildScopeKey(g.objectType, g.objectId),
    baseIds: [g._id],
  };
  const res = await scan(
    budget,
    item.after,
    factRange(
      ctx,
      { type: g.subjectType, id: g.subjectId },
      rule.firstHop.relation,
      rule.objectType,
    ),
    (f) => f.objectId,
    async (f) => {
      const d = derive(rule, f, second);
      await emit(ctx, env, budget, d.row, [d.path]);
    },
  );
  return res.done ? null : { ...item, after: res.after };
}

/**
 * add/second(k, ρ, Π): the first-hop facts `(y, ρ.h, *:ρ.O)` of row
 * k = (x, r, y), each with every path of Π still stored (and current) on k.
 * A path of Π that left k was dropped for a deleted fact (nothing to derive,
 * W) or pruned by a subset, whose own store owes its own item.
 */
async function stepAddSecond(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  item: AddItem<"second">,
) {
  const rule = ruleOf(env, item.rule);
  budget.charge(1);
  const row = await findRow(ctx, item.row);
  const current = isCurrent(env);
  const owed = new Set(item.paths);
  const sources = (row?.paths ?? []).filter(
    (p) => current(p) && owed.has(pathId(p)),
  );
  if (sources.length === 0) return null;
  const [yType, yId] = decodeScopeKey(item.row.objectKey);
  const res = await scan(
    budget,
    item.after,
    factRange(
      ctx,
      { type: yType, id: yId },
      rule.firstHop.relation,
      rule.objectType,
    ),
    (f) => f.objectId,
    async (f) => {
      const paths = sources.map(
        (p) =>
          derive(rule, f, {
            subjectKey: item.row.subjectKey,
            baseIds: p.baseIds,
          }).path,
      );
      await emit(
        ctx,
        env,
        budget,
        derive(rule, f, { subjectKey: item.row.subjectKey, baseIds: [] }).row,
        paths,
      );
    },
  );
  return res.done ? null : { ...item, after: res.after };
}

/**
 * remove(f): every lineage row of the deleted fact f, through
 * `lineage.by_fact`. Each entry drops its path (and that path's lineage rows,
 * this entry included) from its row, so the range is re-read from its start
 * and shrinks to empty; a short page read whole leaves it empty (no lineage
 * row of f is created after f's deletion, Lemma R (1)). No rule is read:
 * every transitive dependent of f has f in its lineage (EXPANSION.md Lemma R).
 */
async function stepRemove(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  item: Extract<WorkItem, { kind: "remove" }>,
  stats: Stats,
) {
  const { maxDepth } = limitsOf(env.config);
  for (;;) {
    if (!budget.fits(2)) return item;
    const n = Math.min(PAGE_MAX, Math.max(1, budget.room - 1));
    budget.charge(1);
    const page = await ctx.db
      .query("lineage")
      .withIndex("by_fact", (q) => q.eq("factId", item.fact))
      .take(n);
    for (const entry of page) {
      if (!budget.fits(1 + maxDepth)) return item;
      budget.enter(1 + pathSize(entry.path));
      if ((await dropPath(ctx, entry.rowId, entry.path)) === "deleted")
        stats.rowsDeleted++;
    }
    if (page.length < n) return null;
  }
}

/**
 * deleteEntity(n): one fact touching n (subject side, then object side; the
 * range is re-read from its start, deleted facts leave it), through
 * `deleteFact`. Its `remove` item is spawned, so it runs before the next fact.
 */
async function stepDeleteEntity(
  ctx: MutationCtx,
  budget: Budget,
  item: Extract<WorkItem, { kind: "deleteEntity" }>,
  stats: Stats,
) {
  const { entity } = item;
  if (!budget.fits(4)) return item;
  budget.charge(1);
  let fact = await ctx.db
    .query("relationships")
    .withIndex("by_subject_relation_object", (q) =>
      q.eq("subjectType", entity.type).eq("subjectId", entity.id),
    )
    .first();
  if (!fact) {
    budget.charge(1);
    fact = await ctx.db
      .query("relationships")
      .withIndex("by_object_relation_subject", (q) =>
        q.eq("objectType", entity.type).eq("objectId", entity.id),
      )
      .first();
  }
  if (!fact) return null;
  budget.enter(3);
  const removed = await deleteFact(ctx, fact);
  stats.factsDeleted++;
  if (removed.rowDeleted) stats.rowsDeleted++;
  budget.spawn(removed.items);
  return item;
}

/**
 * rebuild/derive: every fact, in index order — ensure its mirror and lineage
 * row, and spawn its first-hop and inverse items (and the mirror's second-hop
 * items when the mirror was missing), which run before the next fact. On
 * exhaustion, hand over to rebuild/retire (returned as the next item, behind
 * the last fact's spawned items).
 */
async function stepRebuildDerive(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  item: Extract<WorkItem, { kind: "rebuild" }>,
) {
  const config = configOf(env);
  const res = await scan(
    budget,
    item.after,
    (a, n) =>
      scanIndexAfter(
        ctx,
        "relationships",
        "by_subject_relation_object",
        FACT_FIELDS,
        a,
        n,
      ),
    (fact) => FACT_FIELDS.map((f) => fact[f]),
    async (fact) => {
      budget.charge(1);
      const stored = await ensureMirror(ctx, fact, budget);
      budget.spawn(
        triggersOf(
          config,
          mirrorKeyOf(fact),
          fact._id,
          stored ? [mirrorPathOf(fact._id)] : [],
        ),
      );
    },
  );
  if (!res.done) return { ...item, after: res.after };
  return RETIRE;
}

const RETIRE: WorkItem = { kind: "rebuild", phase: "retire", after: null };

/**
 * rebuild/retire: every effective row, in index order. A path goes when its
 * rule is absent (v1) or not a key of this config, when it has more than
 * `maxDepth` facts, when it names a fact that does not exist, or when it is a
 * `'fact'` path that is not its fact's own mirror. Before a row loses its
 * last path, ONE replacement is re-derived from the first retired path whose
 * facts all exist, under this config (`derivationsWithin`; Lemma 0: a
 * lineage derives a row from its facts alone), so a key change never empties
 * a row that the new rules still derive. One is enough: it only keeps the
 * row readable, and the add items of phase derive re-derive every lineage
 * (P6). A kept path gets any lineage row it lacks (repairs L). A row left
 * with no path is deleted. Charges (EXPANSION.md §5): `|π|` per path (the
 * fact reads), `|π|` more per kept path (its `by_row` lookups), `1 + |π|` per
 * retired path, and the replacement's `writePaths`.
 */
async function stepRebuildRetire(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  item: Extract<WorkItem, { kind: "rebuild" }>,
  stats: Stats,
) {
  const config = configOf(env);
  const { maxDepth } = limitsOf(config);
  const known = ruleIndex(config).byKey;
  const res = await scan(
    budget,
    item.after,
    (a, n) =>
      scanIndexAfter(
        ctx,
        "effectiveRelationships",
        "by_subject_relation_object",
        ROW_FIELDS,
        a,
        n,
      ),
    (row) => ROW_FIELDS.map((f) => row[f]),
    async (row) => {
      const facts = new Map<string, Fact | null>();
      const load = async (id: string) => {
        if (!facts.has(id)) {
          const normalized = ctx.db.normalizeId("relationships", id);
          facts.set(
            id,
            normalized === null ? null : await ctx.db.get(normalized),
          );
        }
        return facts.get(id)!;
      };
      const keep: StoredPath[] = [];
      const retire: StoredPath[] = [];
      for (const p of row.paths) {
        budget.charge(p.baseIds.length);
        let ok =
          p.rule !== undefined && (p.rule === FACT_RULE || known.has(p.rule));
        ok = ok && p.baseIds.length <= maxDepth;
        for (const id of p.baseIds) if (ok && !(await load(id))) ok = false;
        if (ok && p.rule === FACT_RULE) {
          const f = (await load(p.baseIds[0]))!;
          const m = mirrorKeyOf(f);
          ok =
            p.baseIds.length === 1 &&
            m.subjectKey === row.subjectKey &&
            m.relation === row.relation &&
            m.objectKey === row.objectKey;
        }
        (ok ? keep : retire).push(p);
      }
      if (retire.length > 0 && keep.length === 0) {
        // Re-derive one replacement before the last path goes (see above).
        let replacement: EffectivePath | undefined;
        for (const p of retire) {
          const own: Fact[] = [];
          for (const id of p.baseIds) {
            const f = await load(id);
            if (f) own.push(f);
          }
          if (own.length === p.baseIds.length)
            [replacement] = derivationsWithin(config, own, row, maxDepth);
          if (replacement) break;
        }
        const key = {
          subjectKey: row.subjectKey,
          relation: row.relation,
          objectKey: row.objectKey,
        };
        if (replacement) await emit(ctx, env, budget, key, [replacement]);
      }
      for (const p of retire) {
        budget.charge(1 + p.baseIds.length);
        if ((await dropPath(ctx, row._id, pathId(p))) === "deleted")
          stats.rowsDeleted++;
      }
      for (const p of keep) {
        budget.charge(p.baseIds.length);
        await ensureLineage(ctx, row._id, p);
      }
    },
  );
  return res.done ? null : { ...item, after: res.after };
}

/**
 * The minimal lineages of `row` derivable from `facts` alone under the
 * config's rules (EXPANSION.md §1.2 restricted to `facts`): a fixed point
 * over at most `maxDepth` facts, in memory.
 */
function derivationsWithin(
  config: GraphConfig,
  facts: Fact[],
  row: { subjectKey: string; relation: string; objectKey: string },
  maxDepth: number,
): EffectivePath[] {
  type Entry = { s: string; r: string; o: string; paths: EffectivePath[] };
  const table = new Map<string, Entry>();
  const add = (s: string, r: string, o: string, path: EffectivePath) => {
    const k = join(s, r, o);
    const e = table.get(k) ?? { s, r, o, paths: [] };
    table.set(k, e);
    const merged = mergePath(e.paths, path, () => true, Infinity);
    if (merged.kind !== "stored") return false;
    e.paths = merged.paths as EffectivePath[];
    return true;
  };
  const key = (f: Fact) => mirrorKeyOf(f);
  for (const f of facts) {
    const k = key(f);
    add(k.subjectKey, k.relation, k.objectKey, {
      baseIds: [f._id],
      rule: FACT_RULE,
    });
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of config.rules) {
      for (const f of facts) {
        const fk = key(f);
        if (
          f.relation !== rule.firstHop.relation ||
          f.objectType !== rule.objectType
        )
          continue;
        if (f.subjectType !== rule.firstHop.intermediateType) continue;
        for (const e of [...table.values()]) {
          if (e.o !== fk.subjectKey || !rule.secondHop.relations.includes(e.r))
            continue;
          for (const p of e.paths) {
            const d = derive(rule, f, { subjectKey: e.s, baseIds: p.baseIds });
            if (
              d.path.baseIds.length <= maxDepth &&
              add(d.row.subjectKey, d.row.relation, d.row.objectKey, d.path)
            ) {
              changed = true;
            }
          }
        }
        for (const g of facts) {
          if (g.subjectType !== f.subjectType || g.subjectId !== f.subjectId)
            continue;
          if (
            !rule.secondHop.inverses.some(
              (i) =>
                i.relation === g.relation && i.subjectType === g.objectType,
            )
          ) {
            continue;
          }
          const d = derive(rule, f, {
            subjectKey: buildScopeKey(g.objectType, g.objectId),
            baseIds: [g._id],
          });
          if (
            d.path.baseIds.length <= maxDepth &&
            add(d.row.subjectKey, d.row.relation, d.row.objectKey, d.path)
          ) {
            changed = true;
          }
        }
      }
    }
  }
  const hit = table.get(join(row.subjectKey, row.relation, row.objectKey));
  return (hit?.paths ?? []).filter((p) => p.rule !== FACT_RULE);
}

const ROW_FIELDS = ["subjectKey", "relation", "objectKey"] as const;
const FACT_FIELDS = [
  "subjectType",
  "subjectId",
  "relation",
  "objectType",
  "objectId",
] as const;

/**
 * Up to `n` documents strictly after the compound key `after` in index order:
 * the union, in order, of `(f1..f_{i} = after, f_{i+1} > after)` for i from
 * the last field down to the first. At most one range per index field.
 */
async function scanIndexAfter<
  T extends "effectiveRelationships" | "relationships",
>(
  ctx: MutationCtx,
  table: T,
  index: string,
  fields: readonly string[],
  after: string[] | null,
  n: number,
): Promise<Doc<T>[]> {
  const db = ctx.db as any;
  if (after === null) return await db.query(table).withIndex(index).take(n);
  const out: any[] = [];
  for (let i = fields.length - 1; i >= 0 && out.length < n; i--) {
    const page = await db
      .query(table)
      .withIndex(index, (q: any) => {
        let b = q;
        for (let j = 0; j < i; j++) b = b.eq(fields[j], after[j]);
        return b.gt(fields[i], after[i]);
      })
      .take(n - out.length);
    out.push(...page);
  }
  return out;
}

/** Dispatch one item to its step. */
async function step(
  ctx: MutationCtx,
  env: Env,
  budget: Budget,
  item: WorkItem,
  stats: Stats,
): Promise<WorkItem | null> {
  switch (item.kind) {
    case "add":
      if (item.trigger === "first") return stepAddFirst(ctx, env, budget, item);
      if (item.trigger === "inverse")
        return stepAddInverse(ctx, env, budget, item);
      return stepAddSecond(ctx, env, budget, item);
    case "remove":
      return stepRemove(ctx, env, budget, item, stats);
    case "deleteEntity":
      return stepDeleteEntity(ctx, budget, item, stats);
    case "rebuild":
      return item.phase === "derive"
        ? stepRebuildDerive(ctx, env, budget, item)
        : stepRebuildRetire(ctx, env, budget, item, stats);
  }
}

// ---------------------------------------------------------------------------
// 2.8 execute, parseCursor
// ---------------------------------------------------------------------------

/**
 * Run the pending list `items` in this transaction under `env.budget` units
 * (`ENQUEUE_UNITS` of them reserved for the one continuation), depth-first:
 * the head item runs; the items its last entry spawned go to the FRONT,
 * ahead of the head's own remainder. Returns what is left (head first), for
 * the caller to enqueue as ONE continuation (I5); its length is bounded by
 * the schema (EXPANSION.md Lemma B). The transaction's first entry always
 * runs (P4).
 */
export async function execute(
  ctx: MutationCtx,
  env: Env,
  items: WorkItem[],
): Promise<{ rest: WorkItem[]; stats: Stats }> {
  const stats: Stats = { factsDeleted: 0, rowsDeleted: 0 };
  const budget = new Budget(env.budget - ENQUEUE_UNITS);
  const pending = [...items];
  while (pending.length > 0 && !budget.stopped) {
    const head = pending.shift()!;
    const next = await step(ctx, env, budget, head, stats);
    const spawned = budget.take();
    if (next === null || next === RETIRE) budget.finished();
    else if (spawned.length === 0 && !budget.stopped) {
      throw new Error(
        `convzibar: a ${head.kind} step returned without progress`,
      ); // §2.7 (a)–(c)
    }
    pending.unshift(...spawned, ...(next ? [next] : []));
  }
  return { rest: pending, stats };
}

const isWorkItem = (x: unknown): x is WorkItem => validate(vWorkItem, x);

/**
 * Read a continuation payload (CONTRACT §5.3) defensively: it was written by
 * the engine version that enqueued it. The envelope of the previous version,
 * `{ item, … }`, is read as `{ items: [item], … }`. An item that is not a
 * work item of this version is dropped with a warning (EXPANSION.md Lemma Q:
 * the active config's `rebuild` re-derives everything). Null when the
 * envelope itself is unreadable.
 */
export function parseCursor(payload: unknown): Cursor | null {
  const p = payload as Record<string, unknown> | null;
  if (typeof p !== "object" || p === null) return null;
  const raw = Array.isArray(p.items) ? p.items : "item" in p ? [p.item] : null;
  const configHash =
    p.configHash === null || typeof p.configHash === "string"
      ? p.configHash
      : undefined;
  if (raw === null || configHash === undefined || typeof p.budget !== "number")
    return null;
  const items = raw.filter(isWorkItem);
  if (items.length < raw.length) {
    console.warn(
      `Zbar: dropped ${raw.length - items.length} continuation item(s) of an unrecognized shape ` +
        `(a previous engine version); run rebuild to re-derive what they owed.`,
    );
  }
  return {
    items,
    configHash,
    budget: p.budget,
    attempts: typeof p.attempts === "number" ? p.attempts : 0,
  };
}

// ---------------------------------------------------------------------------
// 2.9 insertFact, deleteFact — the seed of every write, always in the
// caller's transaction (CONTRACT §5.3).
// ---------------------------------------------------------------------------

/**
 * Insert the fact and its mirror (with its lineage row); return the mirror's
 * items (to `execute`). Idempotent: an existing fact only has its
 * `properties` patched.
 */
export async function insertFact(
  ctx: MutationCtx,
  env: Env,
  args: {
    subject: Entity;
    relation: string;
    object: Entity;
    properties?: unknown;
  },
): Promise<{ id: Id<"relationships">; items: WorkItem[] }> {
  const { subject, relation, object, properties } = args;
  const existing = await findFact(ctx, subject, relation, object);
  if (existing) {
    if (
      properties !== undefined &&
      JSON.stringify(existing.properties ?? null) !==
        JSON.stringify(properties ?? null)
    ) {
      await ctx.db.patch(existing._id, { properties });
    }
    return { id: existing._id, items: [] };
  }
  const id = await ctx.db.insert("relationships", {
    subjectType: subject.type,
    subjectId: subject.id,
    relation,
    objectType: object.type,
    objectId: object.id,
    properties,
  });
  const fact = (await ctx.db.get(id))!;
  await ensureMirror(ctx, fact);
  return {
    id,
    items: triggersOf(configOf(env), mirrorKeyOf(fact), id, [mirrorPathOf(id)]),
  };
}

/**
 * Delete the fact and drop, from its mirror row, every path naming it (a v1
 * path without lineage included); return the removal item `remove(f)` (to
 * `execute`), which finds every other path naming f through `lineage`.
 */
export async function deleteFact(
  ctx: MutationCtx,
  fact: Fact,
): Promise<{ items: WorkItem[]; rowDeleted: boolean }> {
  await ctx.db.delete(fact._id);
  const mirror = await findRow(ctx, mirrorKeyOf(fact));
  let rowDeleted = false;
  for (const p of mirror?.paths ?? []) {
    if (!p.baseIds.includes(fact._id)) continue;
    if ((await dropPath(ctx, mirror!._id, pathId(p))) === "deleted")
      rowDeleted = true;
  }
  return { items: [{ kind: "remove", fact: fact._id }], rowDeleted };
}
