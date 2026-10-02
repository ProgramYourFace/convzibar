import { buildScopeKey } from "../../shared/keys";
import type { CompiledSet, GraphConfig } from "../../component/types";
import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
import { structuralRelations } from "./structural";

// ============================================================================
// The read-time planner (CONTRACT.md §3).
//
// A set (relation or permission) compiles from its `CompiledSet.arms` into a
// tree of `Traversal` operators, each of whose leaves is one component index
// read:
//
//   Materialised  leaf over `effectiveRelationships` (fact mirrors and
//                 materialized rows) for the set's writable members and the
//                 members with materialized arms.
//   Inverse       leaf over the facts index, flipped: `~T#r` on o is the
//                 nodes x:T with a fact (o, r, x).
//   Compose       first hop (`EdgeExpand`: FACTS of the arm's relations,
//                 typed to the intermediate) joined with the second hop
//                 (`planSet(T, target)`: the full far set).
//   Union         OR of the above.
//   Closure       a recursive set: frontier iteration with a visited set,
//                 at most `maxDepth` steps.
//   Counted       the root of every set that reaches a cycle (`maxLineage`
//                 null): it settles each answer by the fewest facts of the
//                 derivations found (CONTRACT §4.7).
//
// Every node answers each read two ways: as a set of ids, and as `Levels`
// (each id with the fewest facts of the derivations found for it: a fact 1, a
// row its shortest stored path, a Compose 1 + its far set's). Sets with a
// finite `maxLineage` (≤ maxDepth by the compiler) use the first; a `Counted`
// root uses the second and keeps an answer within `maxDepth` facts, throws
// when the only derivations found are longer, and answers no when none is
// found. One rule for check, checkBatch, expandObjects and expandSubjects.
//
// Materialized walks/expands arms contribute nothing beyond `Materialised`:
// their rows are already there. That, plus the first hop reading facts only,
// is why moving an arm between computed and materialized never changes an
// answer (CONTRACT §4).
// ============================================================================

export interface Entity {
  type: string;
  id: string;
}

type Ctx = QueryCtx | ActionCtx;

/** Each id with the fewest facts of the derivations found for it (CONTRACT §4.7). */
type Levels = Map<string, number>;

export interface Traversal {
  /**
   * Index reads on the cheapest path that can answer a check: a leaf is 1, a
   * `Compose` the sum of its hops, a `Union` the min of its children. `Union.of`
   * sorts children by it so narrowing probes the cheap branches first.
   */
  readonly cost: number;

  check(ctx: Ctx, subject: Entity, object: Entity): Promise<boolean>;
  /** Of the candidate object ids, which does `subject` reach? */
  checkBatch(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>>;
  /** Of the candidate subject ids, which reach `object`? */
  checkBatchSubjects(
    ctx: Ctx,
    object: Entity,
    subjectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>>;
  /** Every `objectType` id `subject` reaches. */
  expandObjects(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
  ): Promise<Set<string>>;
  /** Every `subjectType` id reaching `object`. */
  expandSubjects(
    ctx: Ctx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>>;
  /** Union of `expandObjects` over many subjects, batched so chained hops stay O(depth) reads. */
  expandObjectsFromMany(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>>;
  /** Union of `expandSubjects` over many objects. */
  expandSubjectsFromMany(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>>;

  // The same reads with each id's fewest facts.
  checkLevels(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ): Promise<Levels>;
  objectLevels(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Levels>;
  subjectLevels(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Levels>;
}

// ---------------------------------------------------------------------------
// Index primitives. Both tables are read the same way: anchors on one end,
// relations, and a typed far side (a type range, optionally narrowed to ids).
// Rows come back normalised to `{ subjectId, objectId }`.
// ---------------------------------------------------------------------------

type Table = "effective" | "facts";
type Far = { type: string; ids?: readonly string[] };
/** One fact or row, normalised; `facts` is its lineage length (1 for a fact, a row's shortest path). */
type Edge = {
  subjectId: string;
  objectId: string;
  facts: number;
  properties?: unknown;
};

function idOf(scopeKey: string): string {
  return scopeKey.slice(scopeKey.indexOf(":") + 1);
}

async function readForward(
  z: ZbarInternal,
  ctx: Ctx,
  table: Table,
  subjects: readonly Entity[],
  relations: readonly string[],
  far: Far,
): Promise<Edge[]> {
  if (subjects.length === 0 || relations.length === 0) return [];
  if (table === "facts") {
    const rows: any[] = await ctx.runQuery(z.component.queries.factsForward, {
      subjects: subjects.map(({ type, id }) => ({ type, id })),
      relations: [...relations],
      objectRange: far.ids ? undefined : far.type,
      objectPoints: far.ids?.map((id) => ({ type: far.type, id })),
    });
    return rows.map((r) => ({
      subjectId: r.subjectId,
      objectId: r.objectId,
      facts: 1,
      properties: r.properties,
    }));
  }
  const rows: any[] = await ctx.runQuery(z.component.queries.effectiveForward, {
    subjects: subjects.map(({ type, id }) => ({ type, id })),
    relations: [...relations],
    objectPoints: far.ids?.map((id) => buildScopeKey(far.type, id)),
    objectRange: far.ids ? undefined : far.type,
  });
  return rows.map(rowEdge);
}

async function readReverse(
  z: ZbarInternal,
  ctx: Ctx,
  table: Table,
  objects: readonly Entity[],
  relations: readonly string[],
  far: Far,
): Promise<Edge[]> {
  if (objects.length === 0 || relations.length === 0) return [];
  if (table === "facts") {
    const rows: any[] = await ctx.runQuery(z.component.queries.factsReverse, {
      objects: objects.map(({ type, id }) => ({ type, id })),
      relations: [...relations],
      subjectRange: far.ids ? undefined : far.type,
      subjectPoints: far.ids?.map((id) => ({ type: far.type, id })),
    });
    return rows.map((r) => ({
      subjectId: r.subjectId,
      objectId: r.objectId,
      facts: 1,
      properties: r.properties,
    }));
  }
  const rows: any[] = await ctx.runQuery(z.component.queries.effectiveReverse, {
    objects: objects.map(({ type, id }) => ({ type, id })),
    relations: [...relations],
    subjectPoints: far.ids?.map((id) => buildScopeKey(far.type, id)),
    subjectRange: far.ids ? undefined : far.type,
  });
  return rows.map(rowEdge);
}

const rowEdge = (r: any): Edge => ({
  subjectId: idOf(r.subjectKey),
  objectId: idOf(r.objectKey),
  facts: Math.min(
    ...r.paths.map((p: { baseIds: string[] }) => p.baseIds.length),
  ),
});

/** Facts read from either end; exported for `listDirect`. */
export const readFactsForward = (
  z: ZbarInternal,
  ctx: Ctx,
  subjects: readonly Entity[],
  relations: readonly string[],
  far: Far,
) => readForward(z, ctx, "facts", subjects, relations, far);
export const readFactsReverse = (
  z: ZbarInternal,
  ctx: Ctx,
  objects: readonly Entity[],
  relations: readonly string[],
  far: Far,
) => readReverse(z, ctx, "facts", objects, relations, far);

const objectIdsOf = (rows: readonly Edge[]) =>
  new Set(rows.map((r) => r.objectId));
const subjectIdsOf = (rows: readonly Edge[]) =>
  new Set(rows.map((r) => r.subjectId));

function levelsBy(
  rows: readonly Edge[],
  side: "objectId" | "subjectId",
): Levels {
  const out: Levels = new Map();
  for (const r of rows)
    out.set(r[side], Math.min(out.get(r[side]) ?? Infinity, r.facts));
  return out;
}
function minInto(into: Levels, from: Levels, plus = 0) {
  for (const [id, l] of from)
    into.set(id, Math.min(into.get(id) ?? Infinity, l + plus));
}
/** Every id at `facts`. */
const at = (ids: Iterable<string>, facts: number): Levels =>
  new Map([...ids].map((id) => [id, facts]));
/** The fewest facts per id over several answers. */
function minOf(maps: readonly Levels[], plus = 0): Levels {
  const out: Levels = new Map();
  for (const m of maps) minInto(out, m, plus);
  return out;
}
const entities = (type: string, ids: Iterable<string>): Entity[] =>
  [...ids].map((id) => ({ type, id }));

function intersect(
  candidates: readonly string[],
  reachable: ReadonlySet<string>,
): Set<string> {
  const hits = new Set<string>();
  for (const id of candidates) if (reachable.has(id)) hits.add(id);
  return hits;
}

/**
 * Above this many point reads a batched check switches to one range read per
 * relation plus an in-memory intersection. Convex caps a transaction at 4,096
 * index reads; a point per (relation × candidate) exhausts that quickly.
 */
const MAX_POINT_LOOKUPS = 128;

// ---------------------------------------------------------------------------
// Leaf — `(subject, relation ∈ relations, object:objectType)` rows in one table.
// ---------------------------------------------------------------------------

/**
 * Existence and enumeration over one table. Typed: a leaf answers only for
 * objects of `objectType` (a relation name means something only on its own
 * type — CONTRACT §4.1), so any call for another type is empty.
 */
class Leaf implements Traversal {
  readonly cost = 1;

  constructor(
    private readonly z: ZbarInternal,
    private readonly table: Table,
    public readonly objectType: string,
    public readonly relations: readonly string[],
  ) {}

  private live(objectType: string) {
    return this.relations.length > 0 && objectType === this.objectType;
  }

  async check(ctx: Ctx, subject: Entity, object: Entity): Promise<boolean> {
    if (!this.live(object.type)) return false;
    const rows = await readForward(
      this.z,
      ctx,
      this.table,
      [subject],
      this.relations,
      {
        type: object.type,
        ids: [object.id],
      },
    );
    return rows.length > 0;
  }

  async checkBatch(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (!this.live(objectType) || candidateIds.length === 0) return new Set();
    if (candidateIds.length * this.relations.length > MAX_POINT_LOOKUPS) {
      return intersect(
        candidateIds,
        await this.expandObjects(ctx, subject, objectType),
      );
    }
    return objectIdsOf(
      await readForward(this.z, ctx, this.table, [subject], this.relations, {
        type: objectType,
        ids: candidateIds,
      }),
    );
  }

  async checkBatchSubjects(
    ctx: Ctx,
    object: Entity,
    subjectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (!this.live(object.type) || candidateIds.length === 0) return new Set();
    if (candidateIds.length * this.relations.length > MAX_POINT_LOOKUPS) {
      return intersect(
        candidateIds,
        await this.expandSubjects(ctx, object, subjectType),
      );
    }
    return subjectIdsOf(
      await readReverse(this.z, ctx, this.table, [object], this.relations, {
        type: subjectType,
        ids: candidateIds,
      }),
    );
  }

  expandObjects(ctx: Ctx, subject: Entity, objectType: string) {
    return this.expandObjectsFromMany(ctx, [subject], objectType);
  }

  expandSubjects(ctx: Ctx, object: Entity, subjectType: string) {
    return this.expandSubjectsFromMany(ctx, [object], subjectType);
  }

  async expandObjectsFromMany(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    if (!this.live(objectType) || subjects.length === 0) return new Set();
    return objectIdsOf(
      await readForward(this.z, ctx, this.table, subjects, this.relations, {
        type: objectType,
      }),
    );
  }

  async expandSubjectsFromMany(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>> {
    return new Set(
      (await this.subjectLevels(ctx, objects, subjectType)).keys(),
    );
  }

  // The same three reads, each id with its fewest facts (a `Closure` base).

  async checkLevels(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ): Promise<Levels> {
    if (!this.live(objectType) || ids.length === 0) return new Map();
    if (ids.length * this.relations.length > MAX_POINT_LOOKUPS) {
      const all = await this.objectLevels(ctx, [subject], objectType);
      return new Map(
        ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!]),
      );
    }
    const rows = await readForward(
      this.z,
      ctx,
      this.table,
      [subject],
      this.relations,
      { type: objectType, ids },
    );
    return levelsBy(rows, "objectId");
  }

  async objectLevels(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Levels> {
    if (!this.live(objectType) || subjects.length === 0) return new Map();
    return levelsBy(
      await readForward(this.z, ctx, this.table, subjects, this.relations, {
        type: objectType,
      }),
      "objectId",
    );
  }

  async subjectLevels(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Levels> {
    const typed = objects.filter((o) => o.type === this.objectType);
    if (this.relations.length === 0 || typed.length === 0) return new Map();
    return levelsBy(
      await readReverse(this.z, ctx, this.table, typed, this.relations, {
        type: subjectType,
      }),
      "subjectId",
    );
  }
}

/** The set's own rows in `effectiveRelationships` (fact mirrors + materialized derivations). */
class Materialised extends Leaf {
  constructor(
    z: ZbarInternal,
    objectType: string,
    relations: readonly string[],
  ) {
    super(z, "effective", objectType, relations);
  }
}

// ---------------------------------------------------------------------------
// Inverse — `~T#r` on o: the nodes x:T with a fact (o, r, x).
// ---------------------------------------------------------------------------

/**
 * A facts leaf read backwards. The set's object o is the fact's SUBJECT and
 * the member x is the fact's OBJECT, so every method swaps ends. Typed on both
 * sides: members are `subjectType` only (another type with a relation of the
 * same name is a different relation).
 */
class Inverse implements Traversal {
  readonly cost = 1;
  /** Facts `(x:objectType, relation, y:subjectType)`: the same edges, seen from the member. */
  private readonly facts: Leaf;

  constructor(
    z: ZbarInternal,
    public readonly objectType: string,
    public readonly subjectType: string,
    public readonly relation: string,
  ) {
    this.facts = new Leaf(z, "facts", subjectType, [relation]);
  }

  private ok(objectType: string, subjectType: string) {
    return objectType === this.objectType && subjectType === this.subjectType;
  }

  async check(ctx: Ctx, subject: Entity, object: Entity) {
    if (!this.ok(object.type, subject.type)) return false;
    return this.facts.check(ctx, object, subject);
  }

  async checkBatch(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ) {
    if (!this.ok(objectType, subject.type)) return new Set<string>();
    return this.facts.checkBatchSubjects(ctx, subject, objectType, ids);
  }

  async checkBatchSubjects(
    ctx: Ctx,
    object: Entity,
    subjectType: string,
    ids: readonly string[],
  ) {
    if (!this.ok(object.type, subjectType)) return new Set<string>();
    return this.facts.checkBatch(ctx, object, subjectType, ids);
  }

  expandObjects(ctx: Ctx, subject: Entity, objectType: string) {
    return this.expandObjectsFromMany(ctx, [subject], objectType);
  }

  expandSubjects(ctx: Ctx, object: Entity, subjectType: string) {
    return this.expandSubjectsFromMany(ctx, [object], subjectType);
  }

  async expandObjectsFromMany(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ) {
    const typed = subjects.filter((s) => s.type === this.subjectType);
    if (objectType !== this.objectType || typed.length === 0)
      return new Set<string>();
    return this.facts.expandSubjectsFromMany(ctx, typed, objectType);
  }

  async expandSubjectsFromMany(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ) {
    const typed = objects.filter((o) => o.type === this.objectType);
    if (subjectType !== this.subjectType || typed.length === 0)
      return new Set<string>();
    return this.facts.expandObjectsFromMany(ctx, typed, subjectType);
  }

  // One fact each.
  async checkLevels(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ) {
    return at(await this.checkBatch(ctx, subject, objectType, ids), 1);
  }
  async objectLevels(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ) {
    return at(await this.expandObjectsFromMany(ctx, subjects, objectType), 1);
  }
  async subjectLevels(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ) {
    return at(await this.expandSubjectsFromMany(ctx, objects, subjectType), 1);
  }
}

// ---------------------------------------------------------------------------
// EdgeExpand — the first hop of a walks/expands arm. Reads FACTS only.
// ---------------------------------------------------------------------------

/**
 * Facts `(m:intermediateType, r ∈ relations, o:objectType)`. A derived row is
 * never a first hop (CONTRACT §2.1): that is what keeps a materialized arm and
 * the same arm computed equal.
 */
class EdgeExpand {
  constructor(
    private readonly z: ZbarInternal,
    public readonly objectType: string,
    public readonly intermediateType: string,
    public readonly relations: readonly string[],
  ) {}

  /** Intermediates of every object in `objects`. */
  async listMany(ctx: Ctx, objects: readonly Entity[]): Promise<Entity[]> {
    const typed = objects.filter((o) => o.type === this.objectType);
    const rows = await readReverse(
      this.z,
      ctx,
      "facts",
      typed,
      this.relations,
      {
        type: this.intermediateType,
      },
    );
    return entities(this.intermediateType, subjectIdsOf(rows));
  }

  /** Intermediates keyed by the object they hop from. */
  async listPairs(
    ctx: Ctx,
    objects: readonly Entity[],
  ): Promise<Map<string, string[]>> {
    const typed = objects.filter((o) => o.type === this.objectType);
    const rows = await readReverse(
      this.z,
      ctx,
      "facts",
      typed,
      this.relations,
      {
        type: this.intermediateType,
      },
    );
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const arr = out.get(r.objectId);
      if (arr) arr.push(r.subjectId);
      else out.set(r.objectId, [r.subjectId]);
    }
    return out;
  }

  /** Objects whose first hop contains any of `mids`. */
  async listObjects(ctx: Ctx, mids: readonly Entity[]): Promise<Set<string>> {
    if (mids.length === 0) return new Set();
    return objectIdsOf(
      await readForward(this.z, ctx, "facts", mids, this.relations, {
        type: this.objectType,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Compose — first hop (facts) then the full far set.
// ---------------------------------------------------------------------------

/**
 *   subject --second--> m:intermediateType --first hop (facts)--> object
 *
 * Small candidate sets are candidate-first (each candidate's intermediates,
 * then one batched check of the subject against them); large ones flip to
 * subject-first (the subject's reach, intersected).
 */
class Compose implements Traversal {
  readonly cost: number;

  constructor(
    public readonly firstHop: EdgeExpand,
    public readonly second: Traversal,
  ) {
    this.cost = 1 + second.cost;
  }

  async check(ctx: Ctx, subject: Entity, object: Entity): Promise<boolean> {
    return (await this.checkBatch(ctx, subject, object.type, [object.id])).has(
      object.id,
    );
  }

  async checkBatch(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (candidateIds.length === 0 || objectType !== this.firstHop.objectType)
      return new Set();
    if (
      candidateIds.length * this.firstHop.relations.length >
      MAX_POINT_LOOKUPS
    ) {
      return intersect(
        candidateIds,
        await this.expandObjects(ctx, subject, objectType),
      );
    }
    const pairs = await this.firstHop.listPairs(
      ctx,
      entities(objectType, candidateIds),
    );
    const midIds = new Set<string>();
    for (const mids of pairs.values()) for (const m of mids) midIds.add(m);
    if (midIds.size === 0) return new Set();
    const midHits = await this.second.checkBatch(
      ctx,
      subject,
      this.firstHop.intermediateType,
      [...midIds],
    );
    const hits = new Set<string>();
    for (const [objectId, mids] of pairs)
      if (mids.some((m) => midHits.has(m))) hits.add(objectId);
    return hits;
  }

  async checkBatchSubjects(
    ctx: Ctx,
    object: Entity,
    subjectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    return intersect(
      candidateIds,
      await this.expandSubjects(ctx, object, subjectType),
    );
  }

  expandObjects(ctx: Ctx, subject: Entity, objectType: string) {
    return this.expandObjectsFromMany(ctx, [subject], objectType);
  }

  expandSubjects(ctx: Ctx, object: Entity, subjectType: string) {
    return this.expandSubjectsFromMany(ctx, [object], subjectType);
  }

  async expandObjectsFromMany(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    if (subjects.length === 0 || objectType !== this.firstHop.objectType)
      return new Set();
    const T = this.firstHop.intermediateType;
    const midIds = await this.second.expandObjectsFromMany(ctx, subjects, T);
    return this.firstHop.listObjects(ctx, entities(T, midIds));
  }

  async expandSubjectsFromMany(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>> {
    if (objects.length === 0) return new Set();
    const mids = await this.firstHop.listMany(ctx, objects);
    if (mids.length === 0) return new Set();
    return this.second.expandSubjectsFromMany(ctx, mids, subjectType);
  }

  // The first-hop fact plus the far set's count.

  async checkLevels(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ): Promise<Levels> {
    if (ids.length === 0 || objectType !== this.firstHop.objectType)
      return new Map();
    if (ids.length * this.firstHop.relations.length > MAX_POINT_LOOKUPS) {
      const all = await this.objectLevels(ctx, [subject], objectType);
      return new Map(
        ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!]),
      );
    }
    const pairs = await this.firstHop.listPairs(ctx, entities(objectType, ids));
    const mids = new Set([...pairs.values()].flat());
    if (mids.size === 0) return new Map();
    const far = await this.second.checkLevels(
      ctx,
      subject,
      this.firstHop.intermediateType,
      [...mids],
    );
    const out: Levels = new Map();
    for (const [objectId, ms] of pairs) {
      const best = Math.min(...ms.map((m) => far.get(m) ?? Infinity));
      if (best < Infinity) out.set(objectId, best + 1);
    }
    return out;
  }

  async objectLevels(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Levels> {
    if (subjects.length === 0 || objectType !== this.firstHop.objectType)
      return new Map();
    const T = this.firstHop.intermediateType;
    const far = await this.second.objectLevels(ctx, subjects, T);
    // One first-hop read per distinct count among the intermediates.
    const byFacts = new Map<number, string[]>();
    for (const [mid, facts] of far)
      byFacts.set(facts, [...(byFacts.get(facts) ?? []), mid]);
    const reached = await Promise.all(
      [...byFacts].map(async ([facts, mids]) =>
        at(await this.firstHop.listObjects(ctx, entities(T, mids)), facts),
      ),
    );
    return minOf(reached, 1);
  }

  async subjectLevels(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Levels> {
    if (objects.length === 0) return new Map();
    const mids = await this.firstHop.listMany(ctx, objects);
    if (mids.length === 0) return new Map();
    return minOf([await this.second.subjectLevels(ctx, mids, subjectType)], 1);
  }
}

// ---------------------------------------------------------------------------
// Union — OR, with narrowing between children.
// ---------------------------------------------------------------------------

/**
 * `check` probes the cheapest child first (usually the `Materialised` leaf),
 * then runs the rest in parallel (all awaited). `checkBatch*` narrow: each
 * child sees only the candidates earlier children did not cover. `expand*`
 * union every child.
 */
class Union implements Traversal {
  readonly cost: number;

  constructor(public readonly children: readonly Traversal[]) {
    this.cost =
      children.length === 0 ? 0 : Math.min(...children.map((c) => c.cost));
  }

  /** Drops `EMPTY`, flattens nested unions, collapses 0/1 children, sorts by cost. */
  static of(...children: readonly Traversal[]): Traversal {
    const flat: Traversal[] = [];
    for (const c of children) {
      if (c === EMPTY) continue;
      if (c instanceof Union) flat.push(...c.children);
      else flat.push(c);
    }
    const unique = [...new Set(flat)];
    if (unique.length === 0) return EMPTY;
    if (unique.length === 1) return unique[0];
    unique.sort((a, b) => a.cost - b.cost);
    return new Union(unique);
  }

  async check(ctx: Ctx, subject: Entity, object: Entity): Promise<boolean> {
    if (this.children.length === 0) return false;
    if (await this.children[0].check(ctx, subject, object)) return true;
    const rest = this.children.slice(1);
    if (rest.length === 0) return false;
    // All remaining children in parallel, and ALL awaited: a first-true race
    // would return while sibling `runQuery` calls are still in flight, which a
    // Convex function (and convex-test) treats as an error after it completes.
    const results = await Promise.all(
      rest.map((c) => c.check(ctx, subject, object)),
    );
    return results.some(Boolean);
  }

  checkBatch(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ) {
    return this.narrow(candidateIds, (c, rest) =>
      c.checkBatch(ctx, subject, objectType, rest),
    );
  }

  checkBatchSubjects(
    ctx: Ctx,
    object: Entity,
    subjectType: string,
    ids: readonly string[],
  ) {
    return this.narrow(ids, (c, rest) =>
      c.checkBatchSubjects(ctx, object, subjectType, rest),
    );
  }

  expandObjects(ctx: Ctx, subject: Entity, objectType: string) {
    return this.expandObjectsFromMany(ctx, [subject], objectType);
  }

  expandSubjects(ctx: Ctx, object: Entity, subjectType: string) {
    return this.expandSubjectsFromMany(ctx, [object], subjectType);
  }

  async expandObjectsFromMany(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ) {
    const all = await Promise.all(
      this.children.map((c) =>
        c.expandObjectsFromMany(ctx, subjects, objectType),
      ),
    );
    return new Set(all.flatMap((s) => [...s]));
  }

  async expandSubjectsFromMany(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ) {
    const all = await Promise.all(
      this.children.map((c) =>
        c.expandSubjectsFromMany(ctx, objects, subjectType),
      ),
    );
    return new Set(all.flatMap((s) => [...s]));
  }

  async checkLevels(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ) {
    return minOf(
      await Promise.all(
        this.children.map((c) => c.checkLevels(ctx, subject, objectType, ids)),
      ),
    );
  }
  async objectLevels(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ) {
    return minOf(
      await Promise.all(
        this.children.map((c) => c.objectLevels(ctx, subjects, objectType)),
      ),
    );
  }
  async subjectLevels(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ) {
    return minOf(
      await Promise.all(
        this.children.map((c) => c.subjectLevels(ctx, objects, subjectType)),
      ),
    );
  }

  private async narrow(
    candidateIds: readonly string[],
    run: (
      child: Traversal,
      remaining: readonly string[],
    ) => Promise<Set<string>>,
  ): Promise<Set<string>> {
    const hits = new Set<string>();
    let remaining = candidateIds;
    for (const child of this.children) {
      if (remaining.length === 0) break;
      const got = await run(child, remaining);
      if (got.size === 0) continue;
      for (const id of got) hits.add(id);
      remaining = remaining.filter((id) => !hits.has(id));
    }
    return hits;
  }
}

const EMPTY: Traversal = {
  cost: 0,
  check: async () => false,
  checkBatch: async () => new Set<string>(),
  checkBatchSubjects: async () => new Set<string>(),
  expandObjects: async () => new Set<string>(),
  expandSubjects: async () => new Set<string>(),
  expandObjectsFromMany: async () => new Set<string>(),
  expandSubjectsFromMany: async () => new Set<string>(),
  checkLevels: async () => new Map(),
  objectLevels: async () => new Map(),
  subjectLevels: async () => new Map(),
};

// ---------------------------------------------------------------------------
// Counted — answers by fact count (CONTRACT §4.7).
// ---------------------------------------------------------------------------

/**
 * A plan answered through its `Levels`: an id is in the answer when its
 * fewest-facts derivation found uses at most `maxDepth` facts; if any id's
 * only derivations found are longer, the read THROWS (the write side would
 * have recorded a depth failure instead of a row). `Closure` is one; `Counted`
 * wraps the plan of any other set that reaches a cycle.
 */
abstract class CountedPlan implements Traversal {
  abstract readonly cost: number;
  constructor(
    protected readonly label: string,
    protected readonly maxDepth: number,
  ) {}
  abstract checkLevels(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ): Promise<Levels>;
  abstract objectLevels(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Levels>;
  abstract subjectLevels(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Levels>;

  private settle(levels: Levels, only?: readonly string[]): Set<string> {
    const out = new Set<string>();
    let worst = 0;
    for (const id of only ?? levels.keys()) {
      const facts = levels.get(id);
      if (facts === undefined) continue;
      if (facts <= this.maxDepth) out.add(id);
      else worst = Math.max(worst, facts);
    }
    if (worst > 0) {
      throw new Error(
        `convzibar: ${this.label} found only a derivation of ${worst} facts, more than maxDepth ` +
          `(${this.maxDepth}). Raise maxDepth in createZbar options if the hierarchy is legitimately ` +
          `this deep; the read was refused rather than truncated.`,
      );
    }
    return out;
  }

  async check(ctx: Ctx, subject: Entity, object: Entity) {
    return (await this.checkBatch(ctx, subject, object.type, [object.id])).has(
      object.id,
    );
  }
  async checkBatch(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ) {
    return this.settle(
      await this.checkLevels(ctx, subject, objectType, ids),
      ids,
    );
  }
  async checkBatchSubjects(
    ctx: Ctx,
    object: Entity,
    subjectType: string,
    ids: readonly string[],
  ) {
    if (ids.length === 0) return new Set<string>();
    return this.settle(
      await this.subjectLevels(ctx, [object], subjectType),
      ids,
    );
  }
  expandObjects(ctx: Ctx, subject: Entity, objectType: string) {
    return this.expandObjectsFromMany(ctx, [subject], objectType);
  }
  expandSubjects(ctx: Ctx, object: Entity, subjectType: string) {
    return this.expandSubjectsFromMany(ctx, [object], subjectType);
  }
  async expandObjectsFromMany(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ) {
    return this.settle(await this.objectLevels(ctx, subjects, objectType));
  }
  async expandSubjectsFromMany(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ) {
    return this.settle(await this.subjectLevels(ctx, objects, subjectType));
  }
}

/** A non-recursive plan of a set that reaches a cycle, answered by fact count. */
class Counted extends CountedPlan {
  readonly cost: number;
  constructor(
    private readonly plan: Traversal,
    label: string,
    maxDepth: number,
  ) {
    super(label, maxDepth);
    this.cost = plan.cost;
  }
  checkLevels(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ) {
    return this.plan.checkLevels(ctx, subject, objectType, ids);
  }
  objectLevels(ctx: Ctx, subjects: readonly Entity[], objectType: string) {
    return this.plan.objectLevels(ctx, subjects, objectType);
  }
  subjectLevels(ctx: Ctx, objects: readonly Entity[], subjectType: string) {
    return this.plan.subjectLevels(ctx, objects, subjectType);
  }
}

// ---------------------------------------------------------------------------
// Closure — a recursive set (CONTRACT §4.7, §4.8).
// ---------------------------------------------------------------------------

/** One member of a recursive component: its non-recursive part, and its arms that re-enter the component. */
interface ClosureNode {
  key: string;
  objectType: string;
  /** Every arm whose far set lies outside the component, as one plan. */
  base: Traversal;
  /** Walks/expands arms whose far set is in the component: first hop + far set key. */
  steps: { firstHop: EdgeExpand; target: string }[];
}

/**
 * The fixed point of a strongly connected group of sets (a folder tree's
 * `manage ⊇ parent.manage`, a nested group's `member ⊇ group#member`, or a
 * mutual cycle between sets), evaluated as a frontier walk over
 * `(set, node)` pairs with a visited set, at most `maxDepth` steps from where
 * it starts. A derivation of `k` steps (one fact each) ending in a base hit
 * of `b` facts uses `k + b` facts; each id gets its fewest. A walk that
 * reaches the step bound without a hit has found nothing (no, not an error).
 */
class Closure extends CountedPlan {
  readonly cost = 2;
  private readonly root: ClosureNode;
  /** For the downward (object-enumerating) walk: who steps into each key. */
  private readonly stepsInto = new Map<
    string,
    { node: ClosureNode; firstHop: EdgeExpand }[]
  >();

  constructor(
    private readonly nodes: ReadonlyMap<string, ClosureNode>,
    rootKey: string,
    maxDepth: number,
  ) {
    super(`the recursive set ${rootKey}`, maxDepth);
    this.root = nodes.get(rootKey)!;
    for (const node of nodes.values()) {
      for (const step of node.steps) {
        const arr = this.stepsInto.get(step.target) ?? [];
        arr.push({ node, firstHop: step.firstHop });
        this.stepsInto.set(step.target, arr);
      }
    }
  }

  /**
   * Walk up from the candidates, at most `maxDepth` steps, recording each
   * node's base level and the steps between nodes; each candidate's count is
   * then a shortest-path search over what was read. A node with a one-fact
   * hit is not expanded (nothing past it is shorter). Stops early once every
   * candidate has a derivation within the bound.
   */
  async checkLevels(
    ctx: Ctx,
    subject: Entity,
    objectType: string,
    ids: readonly string[],
  ): Promise<Levels> {
    if (objectType !== this.root.objectType || ids.length === 0)
      return new Map();
    const nid = (key: string, id: string) => `${key}\u0000${id}`;
    const level = new Map<string, number>(); // node → its base level, for nodes with a hit
    const up = new Map<string, string[]>(); //  node → the nodes it steps into
    const seen = new Set<string>(ids.map((id) => nid(this.root.key, id)));
    const best = (id: string): number => {
      // Breadth-first from the candidate: k steps to a node with level b.
      let found = Infinity;
      let ring = [nid(this.root.key, id)];
      const visited = new Set(ring);
      for (let k = 0; ring.length > 0 && k <= this.maxDepth; k++) {
        const next: string[] = [];
        for (const n of ring) {
          const b = level.get(n);
          if (b !== undefined) found = Math.min(found, k + b);
          for (const p of up.get(n) ?? []) {
            if (!visited.has(p)) {
              visited.add(p);
              next.push(p);
            }
          }
        }
        ring = next;
      }
      return found;
    };

    let frontier = new Map<string, Set<string>>([
      [this.root.key, new Set(ids)],
    ]);
    let open = [...ids];
    for (let depth = 0; frontier.size > 0; depth++) {
      const keys = [...frontier.keys()];
      const hits = await Promise.all(
        keys.map((key) => {
          const node = this.nodes.get(key)!;
          return node.base.checkLevels(ctx, subject, node.objectType, [
            ...frontier.get(key)!,
          ]);
        }),
      );
      keys.forEach((key, i) => {
        for (const [id, b] of hits[i]) level.set(nid(key, id), b);
      });
      open = open.filter((id) => best(id) > this.maxDepth);
      if (open.length === 0 || depth === this.maxDepth) break;

      const next = new Map<string, Set<string>>();
      await Promise.all(
        keys.flatMap((key) => {
          const node = this.nodes.get(key)!;
          const expand = [...frontier.get(key)!].filter(
            (id) => level.get(nid(key, id)) !== 1,
          );
          if (expand.length === 0) return [];
          return node.steps.map(async (step) => {
            const pairs = await step.firstHop.listPairs(
              ctx,
              entities(node.objectType, expand),
            );
            for (const [childId, mids] of pairs) {
              const child = nid(key, childId);
              for (const mid of mids) {
                const parent = nid(step.target, mid);
                const arr = up.get(child) ?? [];
                arr.push(parent);
                up.set(child, arr);
                if (!seen.has(parent)) {
                  seen.add(parent);
                  const set = next.get(step.target) ?? new Set<string>();
                  set.add(mid);
                  next.set(step.target, set);
                }
              }
            }
          });
        }),
      );
      frontier = next;
    }
    const out: Levels = new Map();
    for (const id of ids) {
      const b = best(id);
      if (b < Infinity) out.set(id, b);
    }
    return out;
  }

  /**
   * Walk up from the objects, at most `maxDepth` steps, breadth-first (each
   * node at its fewest steps); a subject found by a node `k` steps up with a
   * base level `b` has a derivation of `k + b` facts.
   */
  async subjectLevels(
    ctx: Ctx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Levels> {
    const start = objects
      .filter((o) => o.type === this.root.objectType)
      .map((o) => o.id);
    const found: Levels = new Map();
    if (start.length === 0) return found;
    const visited = new Map<string, Set<string>>([
      [this.root.key, new Set(start)],
    ]);
    let frontier = new Map<string, Set<string>>([
      [this.root.key, new Set(start)],
    ]);
    for (let depth = 0; frontier.size > 0; depth++) {
      const next = new Map<string, Set<string>>();
      await Promise.all(
        [...frontier].flatMap(([key, ids]) => {
          const node = this.nodes.get(key)!;
          const ents = entities(node.objectType, ids);
          return [
            node.base
              .subjectLevels(ctx, ents, subjectType)
              .then((hits) => minInto(found, hits, depth)),
            ...(depth === this.maxDepth
              ? []
              : node.steps.map(async (step) => {
                  for (const mid of await step.firstHop.listMany(ctx, ents)) {
                    addNew(visited, next, step.target, mid.id);
                  }
                })),
          ];
        }),
      );
      frontier = next;
    }
    return found;
  }

  /**
   * Seed every member with the objects the subjects reach through its base
   * (each with its count), then push down along the steps for at most
   * `maxDepth` rounds, one fact per step, keeping each node's fewest facts
   * (a node is pushed again only when its count improves).
   */
  async objectLevels(
    ctx: Ctx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Levels> {
    if (objectType !== this.root.objectType || subjects.length === 0)
      return new Map();
    const levels = new Map<string, Levels>(); // key → id → fewest facts
    const seeds = await Promise.all(
      [...this.nodes.values()].map(
        async (n) =>
          [
            n.key,
            await n.base.objectLevels(ctx, subjects, n.objectType),
          ] as const,
      ),
    );
    let frontier = new Map<string, Levels>();
    for (const [key, hits] of seeds) {
      levels.set(key, new Map(hits));
      if (hits.size > 0) frontier.set(key, new Map(hits));
    }
    for (let round = 1; round <= this.maxDepth && frontier.size > 0; round++) {
      const next = new Map<string, Levels>();
      await Promise.all(
        [...frontier].flatMap(([key, ids]) =>
          (this.stepsInto.get(key) ?? []).flatMap(({ node, firstHop }) => {
            // One read per distinct count among the pushed nodes.
            const byFacts = new Map<number, string[]>();
            for (const [mid, facts] of ids)
              byFacts.set(facts, [...(byFacts.get(facts) ?? []), mid]);
            return [...byFacts].map(async ([facts, mids]) => {
              const objects = await firstHop.listObjects(
                ctx,
                entities(this.nodes.get(key)!.objectType, mids),
              );
              const known = levels.get(node.key) ?? new Map<string, number>();
              levels.set(node.key, known);
              for (const id of objects) {
                if ((known.get(id) ?? Infinity) <= facts + 1) continue;
                known.set(id, facts + 1);
                const pushed = next.get(node.key) ?? new Map<string, number>();
                pushed.set(id, facts + 1);
                next.set(node.key, pushed);
              }
            });
          }),
        ),
      );
      frontier = next;
    }
    return levels.get(this.root.key) ?? new Map();
  }
}

function addNew(
  seen: Map<string, Set<string>>,
  next: Map<string, Set<string>>,
  key: string,
  id: string,
) {
  const s = seen.get(key) ?? new Set<string>();
  if (s.has(id)) return;
  s.add(id);
  seen.set(key, s);
  const n = next.get(key) ?? new Set<string>();
  n.add(id);
  next.set(key, n);
}

// ============================================================================
// Compiling sets into plans.
// ============================================================================

const setKey = (objectType: string, name: string) => `${objectType}#${name}`;

function getSet(
  config: GraphConfig,
  objectType: string,
  name: string,
): CompiledSet | undefined {
  return config.sets[objectType]?.[name];
}

/** `inherits[O][S]`: the set and everything it inherits (always contains S when S exists). */
function closureOf(
  config: GraphConfig,
  objectType: string,
  name: string,
): string[] {
  return (
    config.inherits[objectType]?.[name] ??
    (getSet(config, objectType, name) ? [name] : [])
  );
}

function factRelationsOf(
  config: GraphConfig,
  objectType: string,
  name: string,
): string[] {
  return config.factRelations[objectType]?.[name] ?? [];
}

/**
 * The computed walks/expands arms of a set's whole inherits closure, grouped
 * by (intermediate type, far set). Arms with the same far set are one Compose
 * over the union of their first-hop relations — Compose distributes over a
 * union of first hops, so this is the same answer with fewer reads.
 */
function computedHops(config: GraphConfig, objectType: string, name: string) {
  const hops = new Map<
    string,
    { intermediateType: string; target: string; rels: Set<string> }
  >();
  const add = (T: string, target: string, rels: readonly string[]) => {
    if (rels.length === 0) return;
    const k = setKey(T, target);
    const h = hops.get(k) ?? {
      intermediateType: T,
      target,
      rels: new Set<string>(),
    };
    for (const r of rels) h.rels.add(r);
    hops.set(k, h);
  };
  for (const member of closureOf(config, objectType, name)) {
    for (const arm of getSet(config, objectType, member)?.arms ?? []) {
      if (arm.kind === "expands" && !arm.materialized) {
        add(
          arm.subjectType,
          arm.targetSet,
          factRelationsOf(config, objectType, member),
        );
      } else if (arm.kind === "walks" && !arm.materialized) {
        add(
          arm.viaType,
          arm.targetSet,
          factRelationsOf(config, objectType, arm.viaRelation),
        );
      }
    }
  }
  return [...hops.values()];
}

/** Members whose rows are in `effectiveRelationships`: writable ones (fact mirrors) and ones with materialized arms. */
function materialisedMembers(
  config: GraphConfig,
  objectType: string,
  name: string,
): string[] {
  return closureOf(config, objectType, name).filter((m) => {
    const set = getSet(config, objectType, m);
    if (!set) return false;
    return (
      set.writable ||
      set.arms.some(
        (a) => (a.kind === "expands" || a.kind === "walks") && a.materialized,
      )
    );
  });
}

function inverseArms(config: GraphConfig, objectType: string, name: string) {
  const out: { set: string; subjectType: string; relation: string }[] = [];
  for (const member of closureOf(config, objectType, name)) {
    for (const arm of getSet(config, objectType, member)?.arms ?? []) {
      if (arm.kind === "inverse") {
        out.push({
          set: member,
          subjectType: arm.subjectType,
          relation: arm.relation,
        });
      }
    }
  }
  return out;
}

interface PlanState {
  /** Strongly connected component id per set key (recursive groups). */
  scc: Map<string, string[]>;
  /** Plans and plan nodes, memoised by a structural key so equal sub-plans are one object. */
  nodes: Map<string, Traversal>;
  parts: Map<string, SetParts>;
}

const planStates = new WeakMap<GraphConfig, PlanState>();

function stateOf(z: ZbarInternal): PlanState {
  let s = planStates.get(z.graphConfig);
  if (!s) {
    s = {
      scc: recursiveComponents(z.graphConfig),
      nodes: new Map(),
      parts: new Map(),
    };
    planStates.set(z.graphConfig, s);
  }
  return s;
}

/**
 * Tarjan's SCCs over the read-time "set → far set" graph (computed
 * walks/expands arms only: materialized arms are rows, so they never recurse
 * at read time). Returns, for each set in a cycle (an SCC of size > 1 or a
 * self-loop), the members of its component: the planner needs to know WHICH
 * arms re-enter it, so the component is its own, not the compiler's.
 */
function recursiveComponents(config: GraphConfig): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const [O, sets] of Object.entries(config.sets)) {
    for (const name of Object.keys(sets)) {
      edges.set(
        setKey(O, name),
        computedHops(config, O, name).map((h) =>
          setKey(h.intermediateType, h.target),
        ),
      );
    }
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out = new Map<string, string[]>();
  let counter = 0;
  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!edges.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (edges.get(v) ?? []).includes(v)) {
        for (const m of comp) out.set(m, comp);
      }
    }
  };
  for (const v of edges.keys()) if (!index.has(v)) visit(v);
  return out;
}

function memo(z: ZbarInternal, key: string, make: () => Traversal): Traversal {
  const { nodes } = stateOf(z);
  let n = nodes.get(key);
  if (!n) {
    n = make();
    nodes.set(key, n);
  }
  return n;
}

/**
 * A set split for `evaluateManyPermissions`: the `Materialised` relations
 * (answerable for many sets in one batched read) and every other branch.
 * `plan` is their union. `counted`: the set reaches a cycle, so its answers
 * are settled by fact count at `plan` (never branch by branch).
 */
interface SetParts {
  materialised: readonly string[];
  branches: readonly Traversal[];
  plan: Traversal;
  counted: boolean;
}

/**
 * The branches of `(objectType, name)` other than its own recursive steps.
 * `inComponent` (for a member of a recursive component) names the far sets
 * whose arms become Closure steps instead of Composes.
 */
function buildBranches(
  z: ZbarInternal,
  objectType: string,
  name: string,
  inComponent?: ReadonlySet<string>,
) {
  const config = z.graphConfig;
  const materialised = materialisedMembers(config, objectType, name);
  const branches: Traversal[] = [];
  const steps: ClosureNode["steps"] = [];
  for (const inv of inverseArms(config, objectType, name)) {
    branches.push(
      memo(z, `inv:${objectType}|${inv.subjectType}#${inv.relation}`, () => {
        return new Inverse(z, objectType, inv.subjectType, inv.relation);
      }),
    );
  }
  for (const hop of computedHops(config, objectType, name)) {
    const rels = [...hop.rels].sort();
    const firstHop = new EdgeExpand(z, objectType, hop.intermediateType, rels);
    const target = setKey(hop.intermediateType, hop.target);
    if (inComponent?.has(target)) {
      steps.push({ firstHop, target });
      continue;
    }
    branches.push(
      memo(z, `compose:${objectType}|${rels.join(",")}|${target}`, () => {
        return new Compose(
          firstHop,
          planSet(z, hop.intermediateType, hop.target),
        );
      }),
    );
  }
  return { materialised, branches, steps };
}

function materialisedLeaf(
  z: ZbarInternal,
  objectType: string,
  relations: readonly string[],
) {
  if (relations.length === 0) return EMPTY;
  return memo(z, `mat:${objectType}|${relations.join(",")}`, () => {
    return new Materialised(z, objectType, relations);
  });
}

function setParts(z: ZbarInternal, objectType: string, name: string): SetParts {
  const state = stateOf(z);
  const key = setKey(objectType, name);
  const cached = state.parts.get(key);
  if (cached) return cached;

  const set = getSet(z.graphConfig, objectType, name);
  const maxDepth = z.graphConfig.maxDepth ?? 16;
  let parts: SetParts;
  if (!set) {
    parts = { materialised: [], branches: [], plan: EMPTY, counted: false };
  } else {
    const component = state.scc.get(key);
    if (component) {
      // Recursive: the whole component is one Closure, entered at this set.
      const members = new Set(component);
      const nodes = new Map<string, ClosureNode>();
      for (const k of component) {
        const [O, S] = splitKey(k);
        const b = buildBranches(z, O, S, members);
        nodes.set(k, {
          key: k,
          objectType: O,
          base: Union.of(materialisedLeaf(z, O, b.materialised), ...b.branches),
          steps: b.steps,
        });
      }
      const closure = memo(
        z,
        `closure:${key}`,
        () => new Closure(nodes, key, maxDepth),
      );
      parts = {
        materialised: materialisedMembers(z.graphConfig, objectType, name),
        branches: [closure],
        plan: closure,
        counted: true,
      };
    } else {
      const b = buildBranches(z, objectType, name);
      const plan = Union.of(
        materialisedLeaf(z, objectType, b.materialised),
        ...b.branches,
      );
      // A set that reaches a cycle (through any arm) is answered by fact count.
      const counted = set.maxLineage === null;
      parts = {
        materialised: b.materialised,
        branches: b.branches,
        plan: counted
          ? memo(
              z,
              `counted:${key}`,
              () => new Counted(plan, `the set ${key}`, maxDepth),
            )
          : plan,
        counted,
      };
    }
  }
  state.parts.set(key, parts);
  return parts;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf("#");
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * Compile `(objectType, set)` — a relation or a permission — into a plan
 * (CONTRACT §3). Memoised per compiled config. An unknown set is `EMPTY`.
 *
 *   Union( Materialised(writable members ∪ members with materialized arms),
 *          Inverse per inverse arm,
 *          Compose(first hop = facts, planSet(T, target)) per computed walks/expands arm )
 *
 * A set in a recursive component is a `Closure` over the component instead;
 * any other set that reaches a cycle (`maxLineage` null) is that union
 * wrapped in `Counted`, so its answers are settled by fact count (CONTRACT
 * §4.7). The far-set graph outside cycles is a DAG, so the recursion through
 * `planSet` terminates.
 */
export function planSet(
  z: ZbarInternal,
  objectType: string,
  set: string,
): Traversal {
  return setParts(z, objectType, set).plan;
}

// ============================================================================
// getPermissions: many permissions on one (subject, object).
// ============================================================================

/**
 * Granted permissions, in input order. One batched `Materialised` read covers
 * every permission's materialised members (a hit there is a grant: those rows
 * are a subset of the set); the remaining permissions run their other
 * branches, each distinct branch at most once (plans are memoised by
 * structure, so permissions sharing an arm share the branch object).
 */
export async function evaluateManyPermissions(
  z: ZbarInternal,
  ctx: Ctx,
  subject: Entity,
  object: Entity,
  permissions: readonly string[],
): Promise<string[]> {
  const parts = permissions.map((p) => ({
    permission: p,
    ...setParts(z, object.type, p),
  }));
  const allMat = [...new Set(parts.flatMap((p) => p.materialised))];
  const matched = new Set<string>();
  if (allMat.length > 0) {
    const rows: any[] = await ctx.runQuery(
      z.component.queries.effectiveForward,
      {
        subjects: [{ type: subject.type, id: subject.id }],
        relations: allMat,
        objectPoints: [buildScopeKey(object.type, object.id)],
      },
    );
    for (const r of rows) matched.add(r.relation);
  }

  const granted = new Set<string>();
  const pending = parts.filter((p) => {
    if (p.materialised.some((m) => matched.has(m))) {
      granted.add(p.permission);
      return false;
    }
    return p.branches.length > 0;
  });
  // A counted set is settled on its whole plan; every other set's branches
  // are shared between permissions and each run at most once.
  const results = new Map<Traversal, Promise<boolean>>();
  for (const p of pending) {
    for (const b of p.counted ? [p.plan] : p.branches) {
      if (!results.has(b)) results.set(b, b.check(ctx, subject, object));
    }
  }
  await Promise.all(
    pending.map(async (p) => {
      for (const b of p.counted ? [p.plan] : p.branches) {
        if (await results.get(b)) {
          granted.add(p.permission);
          return;
        }
      }
    }),
  );
  return permissions.filter((p) => granted.has(p));
}

// ============================================================================
// .via() — scope a list to the structural neighbourhood of pinned entities.
//
//   subject … via[0] ~ via[1] ~ … ~ via[last] … object
//
// The result is exactly the full list intersected with the structural scope
// (CONTRACT §4.9):
//   • the vias must form a chain of structural links (`~`: a fact between
//     consecutive vias on a relation the compiled arms declare between their
//     types — `structural.ts`);
//   • the enumerated side is restricted to the structural neighbours of the
//     nearest via (objects of via[last], subjects of via[0]);
//   • every candidate is verified through the set's own plan. Structure only
//     says where to look; the plan decides who holds the set. Always run.
//
// There is no subject-side gate: a gate ("does the subject hold something on
// the via?") would drop objects in scope that the subject reaches by another
// arm, which is not the intersection. No "every relation on the via" fallback
// either: a via type the compiled arms never connect to the listed type has an
// empty scope, by definition.
// ============================================================================

/**
 * Nodes of `otherType` linked to `via` by a structural fact in either
 * direction (`structural.ts`). `ids` narrows the read to points.
 */
async function structuralNeighbors(
  z: ZbarInternal,
  ctx: Ctx,
  via: Entity,
  otherType: string,
  ids?: readonly string[],
): Promise<Set<string>> {
  const { outgoing, incoming } = structuralRelations(
    z.graphConfig,
    via.type,
    otherType,
  );
  const far = { type: otherType, ids };
  const [out, inc] = await Promise.all([
    readForward(z, ctx, "facts", [via], outgoing, far),
    readReverse(z, ctx, "facts", [via], incoming, far),
  ]);
  return new Set([...objectIdsOf(out), ...subjectIdsOf(inc)]);
}

async function chainConnected(
  z: ZbarInternal,
  ctx: Ctx,
  via: readonly Entity[],
) {
  const links = await Promise.all(
    via
      .slice(1)
      .map(async (next, i) =>
        (await structuralNeighbors(z, ctx, next, via[i].type, [via[i].id])).has(
          via[i].id,
        ),
      ),
  );
  return links.every(Boolean);
}

/** Objects of `objectType` that `subject` holds `plan` on, within the structural scope of `via[last]`. */
export async function collectViaObjects(
  z: ZbarInternal,
  ctx: Ctx,
  plan: Traversal,
  subject: Entity,
  via: readonly Entity[],
  objectType: string,
): Promise<Set<string>> {
  if (via.length === 0) return new Set();
  const [connected, candidates] = await Promise.all([
    chainConnected(z, ctx, via),
    structuralNeighbors(z, ctx, via[via.length - 1], objectType),
  ]);
  if (!connected || candidates.size === 0) return new Set();
  return plan.checkBatch(ctx, subject, objectType, [...candidates]);
}

/** Subjects of `subjectType` holding `plan` on `object`, within the structural scope of `via[0]`. */
export async function collectViaSubjects(
  z: ZbarInternal,
  ctx: Ctx,
  plan: Traversal,
  object: Entity,
  via: readonly Entity[],
  subjectType: string,
): Promise<Set<string>> {
  if (via.length === 0) return new Set();
  const [connected, candidates] = await Promise.all([
    chainConnected(z, ctx, via),
    structuralNeighbors(z, ctx, via[0], subjectType),
  ]);
  if (!connected || candidates.size === 0) return new Set();
  return plan.checkBatchSubjects(ctx, object, subjectType, [...candidates]);
}
