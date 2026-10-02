# convzibar write-time materialization: the algorithm and its proofs

This file is the proof obligation of `CONTRACT.md` §5.4. It defines the state,
the intended graph, the algorithm as a handful of named functions, the
invariants every transaction keeps, and the propositions P1–P7 with proofs. The
code mirrors it: `mergePath` and the path encoding are in `paths.ts`; every
other function of §2 is in `expand.ts` under the same name, in the same order;
the Convex functions of §2.9 are in `mutations.ts`. If the code and this file
disagree, one of them is wrong; fix both.

## 1. State and the intended graph

### 1.1 State

Every piece of persistent state:

- A **fact** is `f = (s, r, o)` with a document id `f.id`, stored once in
  `relationships`. Ids are never reused: a fact written again after its removal
  is a different fact. `F` is the set of facts present.
- A **row key** is `k = (subjectKey, relation, objectKey)`. The table
  `effectiveRelationships` maps a key to a finite set of **paths** `paths(k)`; a
  row exists iff its path set is non-empty. A path is `π = (baseIds, rule)`:
  `baseIds` is a sorted, duplicate-free set of fact ids (the **lineage**),
  `rule` the `TraversalRule.key` that wrote it, or `'fact'` for a **mirror**. A
  v1 path has no `rule`.
- `pathId(π) = baseIds.join(',') + '/' + rule` names a path (`paths.ts`).
- The **lineage table** `lineage` holds rows `(factId, rowId, path)`, indexed
  `by_fact (factId, rowId, path)` and `by_row (rowId, path, factId)`.
- `expansionFailures` records cursors that gave up (`failed`, `canceled`) and
  derivations refused for a bound (`depth`, `paths`).
- `configs` maps a hash to a compiled `GraphConfig`.
- `activeConfig` holds at most one row, `{ hash }`: the **active** config. Every
  add and rebuild step runs under it (Lemma Q). The transaction of a write under
  another hash makes that hash active and enqueues `rebuild` under it (§2.9).
- A **continuation** is a workpool work item running `continueExpansion` with a
  **cursor** `{ items, configHash, budget, attempts }` (§2.8): the unfinished
  part of one transaction's pending list. A transaction enqueues at most one;
  its length is bounded by the schema (Lemma B). In tests (`mockWorkpool`) the
  cursor is parked in the `mockWorkpool` table instead.

Notation from the config: `rules` is the `TraversalRule` list (`types.ts`,
CONTRACT §5.1). For a rule `ρ`: `ρ.O` = `objectType`, `ρ.d` = `derived`, `ρ.h` =
`firstHop.relation`, `ρ.I` = `firstHop.intermediateType`, `ρ.R` =
`secondHop.relations`, `ρ.V` = `secondHop.inverses`. `D` = `maxDepth`. `B` =
`writeBudget`. `N` = `MAX_PATHS` = 32. `type(n)` is the type part of a node
`n = type:id`. A path is **current** under a config when it is a mirror (rule
`'fact'`), or its rule is a key of that config and it has at most `D` facts
(`rebuild/retire` drops exactly the paths that are not).

### 1.2 The derivation relation

`Λ_F(k)`, the **lineages** of `k` over `F`, is the least family of fact sets
closed under three rules:

- **(M) mirror.** `f = (s, r, o) ∈ F` ⟹ `{f} ∈ Λ_F((s, r, o))`.
- **(R) row second hop.** For a rule `ρ`, a fact `f = (m, ρ.h, o) ∈ F` with
  `type(m) = ρ.I`, `type(o) = ρ.O`, a key `e = (x, r, m)` with `r ∈ ρ.R`, and
  `L ∈ Λ_F(e)`: if `|{f} ∪ L| ≤ D` then `{f} ∪ L ∈ Λ_F((x, ρ.d, o))`.
- **(V) inverse second hop.** For a rule `ρ`, `f` as in (R), and a fact
  `g = (m, q, x) ∈ F` with `{type(x), q} ∈ ρ.V`: if `|{f, g}| ≤ D` then
  `{f, g} ∈ Λ_F((x, ρ.d, o))`.

This is CONTRACT §5.1 read literally: the first hop is a fact (§2.1 "derived
rows are never a first hop"), the second hop is any row of a relation in `ρ.R`,
fact or derived (§2.2), or an inverse fact. The depth bound is part of the
definition (CONTRACT §4.7: a lineage with more than `D` facts is not a
derivation; attempting one is recorded, §2.4).

The **intended graph** is `E*(F) = { k : Λ_F(k) ≠ ∅ }`, and the intended paths
of `k` are `Min Λ_F(k)`, the ⊆-minimal lineages.

**Lemma 0 (a lineage uses only its own facts).** `L ∈ Λ_F(k)` iff `L ⊆ F` and
`L ∈ Λ_L(k)`. Hence for any fact `f`: `Λ_{F∖{f}}(k) = { L ∈ Λ_F(k) : f ∉ L }`.

_Proof._ Induction on the closure rules: each rule's conclusion is the union of
the facts it uses, so a derivation of `L` uses exactly the facts in `L` and
remains a derivation in any `F' ⊇ L`. ∎

Lemma 0 is why removal by lineage is the right removal (a row survives the
removal of `f` exactly when it has a lineage without `f`), and why `rebuild` may
re-derive a row from one path's facts alone (§2.7, retire).

### 1.3 The target: an exact state

The effective table is **exact for `F`** when, for every key `k`:

- **(Sound)** every stored path's `baseIds` is in `Λ_F(k)`;
- **(Covering)** every `L ∈ Λ_F(k)` has a stored path whose `baseIds ⊆ L`.

**Lemma 1.** If the table is exact for `F` and every row's paths form an
antichain under ⊆ (no stored lineage a subset of another; §2.3 keeps this), its
row keys are `E*(F)` and `paths(k) = Min Λ_F(k)` for every row (comparing
`baseIds`).

_Proof._ A row exists iff it has a stored path iff (Sound, Covering)
`Λ_F(k) ≠ ∅`. Let `m ∈ Min Λ_F(k)`; Covering gives a stored `σ ⊆ m`, Sound puts
`σ ∈ Λ_F(k)`, so `σ = m` by minimality. Conversely, a stored `σ` that is not
minimal has some `m ⊊ σ` in `Λ_F(k)`, hence a stored path `⊆ m ⊊ σ`,
contradicting the antichain. ∎

The tests compare exactly this: the drained row set and `paths(k)` per row
against an independent evaluator of §1.2, plus Sound per stored path and L.

### 1.4 The lineage table

**Invariant L.** `lineage` holds exactly one row `(f, k, pathId(π))` for every
row `k`, every stored path `π` of `k` that has a rule, and every
`f ∈ π.baseIds`; and nothing else. (v1 paths have none; `rebuild` retires them.)

Every writer of §2.4 maintains L in the same transaction as the path change:
storing `π` inserts its `|π|` lineage rows; dropping or pruning `π` deletes its
`by_row (k, pathId(π))` range; deleting a row deletes the ranges of all its
paths.

## 2. The algorithm

A **work item** is plain data (§3, I4); a transaction runs a list of them under
a budget and hands the rest to the workpool.

### 2.1 `ruleIndex(config)`

Four lookups built once per config object:

- `byKey[key]` — the rule with that key;
- `firstHop[(O, h, I)]` — rules with `ρ.O = O, ρ.h = h, ρ.I = I`;
- `secondHop[(I, r)]` — rules with `ρ.I = I, r ∈ ρ.R`;
- `inverse[(I, T, q)]` — rules with `ρ.I = I, {T, q} ∈ ρ.V`.

### 2.2 `derive(ρ, f, (x, lineage)) → (row, path)`

Pure. With `f = (m, ρ.h, o)` and the second hop `(x, lineage)` (a row's subject
and one of its paths, or an inverse fact's object and `[g]`):
`row = (x, ρ.d, o)`, `path = (sort(unique([f.id, ...lineage])), ρ.key)`.

### 2.3 `mergePath(paths, π, isCurrent, cap = N) → dominated | full | stored` (`paths.ts`)

Pure. Keeps a row's paths an antichain:

- **dominated** when some stored path that is CURRENT has `baseIds ⊆ π.baseIds`.
  A path of a retired rule (or a v1 path, or one over a lowered `D`) never
  dominates, so `rebuild` can store a replacement before it retires the old path
  (§2.7), and a derivation over a lowered `D` is refused and recorded even when
  the old over-long path is still stored.
- otherwise the stored paths whose `baseIds ⊇ π.baseIds` are pruned. Of the
  rest, only CURRENT paths count against the cap: **full** when the current ones
  plus `π` are more than `cap`. A non-current path never blocks a current one;
  instead, while the row would hold more than `cap` paths, its first non-current
  paths are **evicted** (dropped with the pruned ones). The new paths are the
  rest plus `π`.

Pruning a superset is safe: any removal that kills `π` kills the superset too,
so the superset adds no liveness, and Covering only needs a stored path `⊆` each
lineage (§4, P2). Evicting a non-current path is safe: neither Sound nor
Covering under the active config relies on one (P6), the row keeps `π`, and
`rebuild/retire` would drop the path anyway. With `cap = N`, every row
`writePaths` writes holds at most `N` paths; `ensureMirror` (`cap = ∞`) can add
the row's mirror on top, so a row holds at most `N + 1` paths (P7).

### 2.4 `writePaths`, `ensureMirror`, `ensureLineage`, `dropPath`, `deleteRow` — the only writers

**`writePaths(k, candidates)`.** Read row `k`; for each candidate `π` in order:

| condition                                     | action                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---- | --------------------------------------- |
| `mergePath` says dominated                    | skip                                                                                                  |
| `                                             | π                                                                                                     | > D` | insert `expansionFailures{depth}`, skip |
| some fact of `π` is absent (`get` of each id) | skip — **this is Invariant W**                                                                        |
| `mergePath` says full                         | insert `expansionFailures{paths}`, skip                                                               |
| otherwise                                     | drop the lineage of each pruned or evicted path, write the row's new paths, insert `π`'s lineage rows |

Returns the paths it stored (the row changed iff there is one). The caller then
owes their second-hop items (§2.5).

**`ensureMirror(f)`.** Make `([f], 'fact')` a path of `f`'s mirror row with its
lineage row. Nothing dominates a mirror and no cap applies: an untagged v1 `[f]`
and every stored superset of `[f]` are pruned. If the mirror path is already
there, only its lineage row is ensured. Returns whether it stored. Within a
budget (`rebuild/derive`) each pruned path is charged `1 + |σ|`; the pruned
paths are paths of one row, so at most `N + 1`. A fact just inserted has no
superset to prune (no stored path names a new id, W).

**`ensureLineage(k, π)`.** Insert each lineage row `(f, k, pathId(π))` that a
kept path lacks: one `by_row` lookup per fact (`rebuild/retire`, for paths
written before L existed).

**`dropPath(k, pathId)`.** Delete the path's lineage rows (`by_row`), remove the
path from row `k`, delete the row if no path remains. The lineage rows go even
when the path is already gone, so a removal scan always shrinks.

**`deleteRow(k)`.** Delete the lineage ranges of every path of `k`, then the
row. Only maintenance calls it, for rows with no fact behind them.

### 2.5 `triggersOf(row, mirror?, stored) → add items` (CONTRACT §5.2)

For a row `k = (x, r, y)` on which the paths `stored` (`Π`) were just stored:

- **first-hop** (only when the change stored the mirror of fact `f`): for every
  `ρ ∈ firstHop[(type(y), r, type(x))]`, the item `add/first(f, ρ)`.
- **inverse** (same condition): for every `ρ ∈ inverse[(type(x), type(y), r)]`,
  the item `add/inverse(f, ρ)`.
- **second-hop** (`Π` non-empty): for every `ρ ∈ secondHop[(type(y), r)]`, one
  item `add/second(k, ρ, Π)` carrying the `pathId`s of `Π`. It derives from
  those paths only (those still stored and current when it runs): a path already
  on `k` before the change has its own item, from its own store. Carrying `Π` is
  what makes a chain of nested items grow its lineage, which bounds the pending
  list (Lemma B).

Every entry spawns at most `3·|rules|` items (a mirror: first-hop, inverse and
second-hop rules, at most `|rules|` each) and every derived change at most
`|rules|` (one second-hop item per rule, whatever `|Π|`).

### 2.6 `Budget` and `scan`

A `Budget` is the state of one TRANSACTION, shared by its steps: `allowance`
(`B − 2`: 2 units are kept for its one continuation), `spent`, `progressed` (an
entry was begun or an item finished), `stopped`, and `spawned` (the items the
current step owes; `execute` takes them after each step).
`room = allowance − spent`; `fits(c)` is `¬progressed ∨ room ≥ c`, so a
transaction's first entry always runs, and a failed check sets `stopped`;
`charge(c)` adds to `spent`; `enter(c)` begins an entry.
`scan(after, fetch, keyOf, process)` iterates one index range in pages strictly
after the key `after`: each fetch costs 1 unit; pages hold 2, 4, 8, … entries
(doubling while read whole) up to `min(256, room − 1)`; each entry costs 1 plus
what `process` charges. It returns right after an entry that spawned items (they
run first; `done` if that entry ended a short page), when a check fails, or
`done` on a short page read to its end; `after` is the last processed key.
`scanIndexAfter(table, index, fields, after, n)` is the fetch of the rebuild
scans: the first `n` documents strictly after the compound key `after`, as the
union of at most one range per index field.

### 2.7 One step per work item

Each step runs one item under the transaction's `Budget` and returns the same
item with its cursor advanced, or nothing when finished. It returns an
unfinished item only (a) when a budget check failed (`stopped`), (b) right after
an entry that spawned items, which run before the item's next entry
(depth-first: an entry is processed fully, its derived work included, before the
range moves on), or (c) when `rebuild/derive` hands over to `rebuild/retire`.
The items and their fields:

| item             | fields                    | source read first (1 unit)                             | per range entry                                                                                                                                                                                        |
| ---------------- | ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ----------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------ |
| `add/first`      | `fact, rule, part, after` | `f = get(fact)`; stop if absent                        | part `<                                                                                                                                                                                                | ρ.R | `: row `e = (\*, ρ.R[part], m)`→`writePaths(derive(ρ, f, (e.subject, p)))`for every current`p ∈ e`; part `≥ | ρ.R | `: inverse fact `g = (m, q, \*:T)`→`derive(ρ, f, (g.object, [g]))` |
| `add/inverse`    | `fact, rule, after`       | `g = get(fact)`; stop if absent                        | fact `f = (g.subject, ρ.h, *:ρ.O)` → `derive(ρ, f, (g.object, [g]))`                                                                                                                                   |
| `add/second`     | `row, rule, paths, after` | row `k`'s current paths named in `paths`; stop if none | fact `f = (y, ρ.h, *:ρ.O)` → `derive(ρ, f, (k.subject, p))` for every such `p`                                                                                                                         |
| `remove`         | `fact`                    | —                                                      | `lineage.by_fact(fact)`, re-read from its start (a short page read whole ends it: Lemma R (1)): entry `(f, k, p)` → `dropPath(k, p)`                                                                   |
| `deleteEntity`   | `entity`                  | —                                                      | ONE fact touching the entity (subject side, then object side; `first()`, re-read from the start) → `deleteFact` (§2.9), spawn its `remove`                                                             |
| `rebuild/derive` | `after`                   | —                                                      | a fact, in index order → `ensureMirror`; spawn its first-hop and inverse items (and the mirror's second-hop items if the mirror was missing). When exhausted, return `rebuild/retire` as its next item |
| `rebuild/retire` | `after`                   | —                                                      | a row, in index order → see below                                                                                                                                                                      |

Add steps derive only from CURRENT paths: a path another config wrote (or a v1
path) is not a derivation this config vouches for. Without this, a rebuild under
a new config could derive from a stale row of an old rule and stamp the result
with a current key, which no later step would retire.

`rebuild/retire` classifies each path of the row: it is **retired** when its
rule is absent or not a key of the config, when `|baseIds| > D`, when it names a
fact that does not exist (`get` per fact), or when it is a `'fact'` path that is
not its fact's own mirror; every other path is **kept**. If every path is
retired, the row is first re-derived: `derivationsWithin(facts, k)` evaluates
§1.2 in memory over the facts of the first retired path whose facts all exist
(at most `D` facts; Lemma 0 makes it exact for derivations inside them), and its
first lineage of `k`, if any, goes through `writePaths` (with its second-hop
items when stored). One replacement is enough: it only keeps the row readable;
Covering never relies on it, since the add items of phase derive re-derive every
lineage (P6). Then each retired path is dropped (`dropPath`; the row goes with
its last path) and each kept path goes through `ensureLineage` (this restores L
for data written before L existed).

### 2.8 `execute(items)` and `parseCursor(payload)` — ONE CHUNK, ONE CONTINUATION

A transaction runs under an `Env`: its `config` (null for removal-only work,
which reads no rule), `configHash` and `budget` (units); `Stats` counts the
facts and rows it deleted, for the caller's return value. `execute` keeps a
**pending list**, a stack whose head runs next. While the list is non-empty and
the budget has not stopped: take the head, run its step, and put back, at the
FRONT, the items its last entry spawned followed by its `next`:

```
pending := spawned ++ [next] ++ rest
```

So spawned work runs depth-first, before the item that spawned it moves on. When
the loop stops, `execute` returns what is left; the caller
(`executeAndContinue`, `mutations.ts`) enqueues it, followed by any `owed` item
(an activation's `rebuild`, §2.9), as ONE continuation, the **cursor**
`{ items, configHash, budget: writeBudget, attempts: 0 }`, or nothing when both
are empty. No transaction enqueues anything else, so a chunk never schedules
more than one function, and its payload is a cursor list, never a row list:
Lemma B bounds its length by the schema. A step that returns its item unfinished
without (a)–(c) of §2.7 is a bug; `execute` throws.

`parseCursor` reads a payload defensively (`continueExpansion`, `chunkCompleted`
and `resumeExpansion` take `v.any()` at the boundary): the envelope of the
previous engine version, `{ item, … }`, is read as `{ items: [item], … }`; an
item that does not validate as a work item of this version (e.g. an `add/second`
without `paths`) is dropped with a `console.warn` (Lemma Q, the consequence of a
version change); an unreadable envelope is dropped likewise. A bad payload
therefore never fails at the boundary, where nothing would record it.

### 2.9 Entry points (`insertFact`, `deleteFact` in `expand.ts`; the rest in `mutations.ts`)

- `insertFact` / `addRelation`: if the fact exists, patch `properties` and stop
  (idempotent). Else insert it, `ensureMirror`, and
  `execute(triggersOf(mirror, f))`. The fact and its mirror are always written
  in the caller's transaction.
- `deleteFact` / `removeRelation`: delete the fact; on its mirror row drop every
  path naming it (v1 paths without lineage included); `execute(remove(f))`.
  Removal reads no rule: `remove(f)` finds every path naming `f` through
  `lineage` (Lemma R).
- `setRelation`: in one transaction, `insertFact` the new fact, `deleteFact`
  each other relation the subject holds on the object, and `execute` the add
  items **before** the removal items. Both orders converge to the same state
  (P2); the order only matters to a reader while work is pending. Adding first
  means a row that both the old and the new fact derive gains its new path
  before it loses its old one, so it never disappears; the cost is that a row
  only the old fact derived can be read until the removal reaches it, the same
  window as any removal.
- `deleteEntity`: `execute(deleteEntity(n))`.
- `rebuild`: `execute(rebuild/derive)`.
- **`envOf` (every public write, first).** Register the config if it is new
  (`ensureConfig`, `config.ts`), then `activateConfig(hash)`: if `hash` is not
  the active hash, make it active and owe `rebuild/derive` under it: the write's
  one continuation carries it after the write's own leftovers (the `rebuild`
  mutation runs it instead). This covers a new config (a deploy) and a return to
  an earlier one (a rollback) alike. The one exception: with no active row and
  no fact (a fresh component, every test's first write) the hash becomes active
  and nothing is enqueued, since there is nothing to rebuild. With no active row
  but facts present (rows written before the active row existed), the rebuild is
  enqueued.
- **Stale items.** An item of a cursor is **stale** when it is an add or rebuild
  item and the cursor's `configHash` is not the active hash (with an active row
  present). Removal items (`remove`, `deleteEntity`, and every item of a cursor
  whose `configHash` is null) read no rule and are never stale. `liveCursor` =
  `parseCursor`, then drop the stale items; nothing left means nothing to run.
- `continueExpansion(payload)`: `liveCursor` (it reads the active hash); stale
  items do not run (Lemma Q: nothing is owed to them). Load the config by
  `configHash` (none when it is null: a removal started by maintenance) and
  `executeAndContinue(items)` under the cursor's budget.
- `chunkCompleted` (workpool `onComplete`): on success, nothing. On
  `failed`/`canceled`: `liveCursor` of its context; nothing left, nothing to do;
  otherwise re-enqueue the same cursor (the same list) with `budget/2` (at
  least 1) and `attempts+1`; after 5 attempts, insert
  `expansionFailures{cursor, reason, error, attempts}` and `console.error`. It
  reads its arguments, the active hash, and the workpool's own state (its
  `enqueue`); never the data its chunk read.
- `resumeExpansion(failureId)` deletes the record and re-enqueues the stored
  cursor's live items with the budget reset to the config's `writeBudget` and
  `attempts` reset to 0. Not for `depth`/`paths`: those are repaired by
  `rebuild`. `listExpansionFailures` lists the records.

## 3. Invariants

Time is the total order of events: Convex runs mutations serializably, so
committed transactions have a total order consistent with their reads, and
inside one transaction the steps run sequentially and see each other's writes. A
retried transaction (OCC) leaves no trace, so only committed events exist. Every
claim below is about this order.

- **W (written while live).** A path is written only in a transaction that read
  every fact of its `baseIds` and found it present: `writePaths` gets each id (≤
  `D` reads) before storing; `ensureMirror` runs on a fact the transaction just
  inserted or read. By serializability, a transaction that deletes one of those
  facts is ordered after the write and sees its lineage row.
- **L** (§1.4).
- **I1 (provenance).** A stored path is either a mirror `([f], 'fact')` written
  while `f` exists, or `derive(ρ, f, ·)` where, in the writing transaction, `f`
  was read as a fact matching `ρ` and the second hop was read present (an
  inverse fact, or a current path on its row); its `baseIds` has at most `D`
  facts. So by induction on write order every stored path is a derivation from
  its own facts: `π ∈ Λ_π(k)`.
- **I2 (path removal).** A stored path leaves its row only by: `dropPath` for a
  fact it names that was deleted (`deleteFact`, `remove`); pruning by a stored
  path whose lineage is a strict subset (§2.3); eviction of a non-current path
  by `writePaths` storing a current one (§2.3); `rebuild/retire`; or
  maintenance's `deleteRow`.
- **I3 (mirror).** The path `([f], 'fact')` is on row `(s, r, o)` iff
  `f = (s, r, o)` exists: written by `ensureMirror` when `f` is inserted,
  dropped in the transaction that deletes `f`, never pruned (nothing is a strict
  subset of `[f]`), and kept by `rebuild` while `f` exists.
- **I4 (pure items).** A work item and its cursor are plain data: the kind, the
  source's id or key, the rule key, the `pathId`s it owes (add/second), the last
  index key. A step's result is a function of the item and the database it
  reads.
- **I5 (no lost obligation).** A change creates its items in the same
  transaction (a stored path: `triggersOf`; a deleted fact: `remove`), and every
  item a transaction holds when it commits is either finished or in the one
  continuation it enqueues in that transaction. A step's `next` is persisted in
  the same transaction as the writes it covers.

## 4. Propositions

Throughout, "drained" means every enqueued cursor has completed and none failed,
and the active config does not change (P6 and Lemma Q treat a change).

**Lemma S (scan coverage).** Let `w` be an add item created at event `t`, and
let `z` be an element of `w`'s range (a row or a fact with a key in the range)
that is present from `t` to the end, while `w`'s source stays present from `t`
to the end (for `add/second(k, ρ, Π)`, the source is a path of `Π` stored and
current on `k`). Then some step of `w` reads `z` and processes it at an event
where `z` and the source are present.

_Proof._ By I5 the chain of `w`'s continuations is never lost (P4 for failures).
Each step re-reads the source (still present, so it does not stop early) and
reads a page of keys strictly after its cursor, in index order; the cursor only
advances past keys it processed; the chain ends only on a short page. `key(z)`
exists in every snapshot from `t` on, so the first page whose interval reaches
`key(z)` contains `z`. An add step deletes no fact and no row (it only stores
paths and prunes supersets of what it stores), so `z` and the source are still
present when the entry is processed later in the same step. ∎

**Lemma R (removal completeness).** Let fact `x` be deleted at event `t_x`.
Every path naming `x` that is stored at any event after `t_x` is dropped by the
`remove(x)` chain, which ends only when no stored path names `x`. Hence,
drained, no stored path names a deleted fact.

_Proof._ (1) _No path naming `x` is written after `t_x`._ By W the writing
transaction read `x` present, so it is ordered before the deletion (or is the
deleting transaction itself before its delete, in which case its lineage row
exists when the delete happens). (2) _Every stored path naming `x` has a lineage
row `(x, k, π)`_ (L). (3) `deleteFact(x)` creates `remove(x)` at `t_x` (I5).
Each of its steps reads `lineage.by_fact(x)` from the start and drops, with
`dropPath`, the path of every entry it processes — which deletes that entry
(§2.4). By (1) no entry for `x` is created after `t_x`, so the range only
shrinks, every step that processes an entry makes it strictly smaller, and the
chain ends (an empty first page) exactly when the range is empty, i.e. (2) when
no stored path names `x`. ∎

No rule is read anywhere in this proof: removal is complete under any config,
including one that has no rule for the paths it removes, and whatever config
wrote them. Every transitive dependent of `x` is reached because its lineage
contains `x` (lineage is the full fact set of a derivation, I1), not because a
rule locates it.

**Lemma Q (only the active config writes derived paths).** Let the active hash
become `C` at event `t_C`. Until it changes again, every add and rebuild step
runs under `C`. Hence (a) every derived path stored after `t_C` is tagged with a
rule of `C`, and (b) a stale cursor that is dropped owes nothing: the table `C`
must reach is produced without it.

_Proof._ A step runs only inside `execute`, which is called from three places.
(1) A public write, after `envOf`: `envOf` reads the active hash and, if it is
not the write's own hash, sets it to that hash, all before the first step and in
the same transaction; so the write's steps run under the hash active at their
commit. (2) `continueExpansion`: it reads the active hash in the same
transaction as the step, and returns without running an add or rebuild item
whose hash differs. (3) Maintenance: removal items only, with no config.
`chunkCompleted` and `resumeExpansion` run no step; they only enqueue (or drop a
stale cursor). Convex serializes transactions, so no change of the active hash
is ordered between the read in (1) or (2) and the steps in the same transaction.
Every derived path is written by an add or rebuild step (§2.4: `writePaths` is
called only from `emit` and `rebuild/retire`), so (a) holds.

For (b): a stale cursor's item is an add or rebuild of another config. The
transaction that made `C` active (at `t_C`, ordered before the cursor's run,
which read `C`) also enqueued `rebuild/derive` under `C`, unless the component
then had no active row and no fact. In the first case `C`'s rebuild re-derives
from every fact (P6's Covering does not use any other config's work), and by (a)
it retires every non-current path, because all of them are stored before `t_C`
and so before its retire pass. In the second case nothing was derived from any
fact before `t_C`, and there is nothing to redo. What the dropped item would
have written is either a path of another config (not owed under `C`) or, by (a),
nothing at all. Removal items are never stale: they read no rule, and Lemma R
needs every one of them. ∎

This replaces the earlier _assumption_ (Q), "no cursor of another config runs
during or after the rebuild", with a property of the code. Without it, an old
cursor that ran after `C`'s retire had passed a row could store an old-key path
there, and its `mergePath` (old `isCurrent`) could prune a new path that is a
superset of the old one. That left the row wrong for `C` with nothing queued to
repair it.

_Consequence for an engine upgrade._ The same argument covers the one other
drop: an item of a shape this engine version does not know (a cursor queued by a
previous version, §2.8 `parseCursor`), dropped with a `console.warn`. What it
owed is owed under the active config, whose `rebuild` re-derives from every fact
(P6) and retires every path no fact justifies; an upgrade that changes the item
format does not change the config hash, so the operator runs `rebuild` after it
(the warning says so).

**P1 (idempotence).** Executing a chunk again — immediately, or at any later
point — writes no row that the first execution did not, and the drained state is
the same as with a single execution.

_Proof._ After an add step, every candidate it derived is dominated in its row
(stored, or a current subset already stored) or was refused (absent fact, depth,
full); within the step nothing makes it undominated (I2: an add step only prunes
supersets of what it stores). A re-run reads the same source and range and
derives the same candidates, all dominated or refused for the same reason;
nothing is written, nothing spawned. A re-run removal finds its range already
empty. For a later re-run, P2's proof does not assume that an item runs once:
extra executions write only paths satisfying I1 and W, which is all Sound needs,
and can only add coverage. ∎ (The `expansionFailures` log is at-least-once: a
re-run that tries the same over-long lineage or the same full row records it
again.)

**P2 (order independence).** Drained, the table is exact for the facts then
present, for every interleaving of the adds, removals, `setRelation`s and
`deleteEntity`s and their chunks — unless an `expansionFailures{paths}` row was
recorded (P7). By Lemma 1 its rows are `E*(F)` and `paths(k) = Min Λ_F(k)`.

_Proof._ Let `F` be the final facts.

_Sound._ Let `π` be stored at the end on `k`. By Lemma R every fact of `π` is in
`F`. By I1, `π ∈ Λ_π(k)`, so by Lemma 0 `π ∈ Λ_F(k)`.

_Covering._ Induction on the derivation of `L ∈ Λ_F(k)`. (M): the mirror is
stored (I3). (R): `L = {f} ∪ L_e`; by induction `e` stores some `p ⊆ L_e` at the
end; take the event `t_p` at which that copy of `p` was written, and the
insertion `t_f` of `f`. All facts of `p` and `f` are final.

- `t_f < t_p`: the write of `p` changed row `e` and created
  `add/second(e, ρ, Π)` with `p ∈ Π` (I5). Its source (`p`, current on row `e`)
  and the element `f` are present from `t_p` on, so by Lemma S a step reads `f`
  while `p` is on `e` and derives `{f} ∪ p`.
- `t_p < t_f`: the insertion of `f` created `add/first(f, ρ)`, whose range
  contains `e`; `e` holds `p` from `t_f` on, so by Lemma S the step reads `e` —
  with `p`, since the page is read after `t_p` — and derives `{f} ∪ p`.

`writePaths` then finds the candidate dominated by a current stored path
`⊆ {f} ∪ p`, or stores it; it cannot fail W (its facts are final, hence
present), and if `|{f} ∪ p| > D` then `|L| > D` and `L` is no lineage, so
nothing is owed. Either way a path `⊆ L` is on `k` after that event. Such a path
is never dropped for a deleted fact (its facts are in `L ⊆ F`), and if pruned
its replacement is a strict subset, still `⊆ L` (I2); so some path `⊆ L` is on
`k` at the end. (V) is the same with `g` for `p`, using `add/inverse(g, ρ)` and
the inverse part of `add/first(f, ρ)`. ∎

This is the proposal's serializability argument made precise: a chunk sees a
concurrent write if it is ordered before the chunk's read; if it is ordered
after, the write's own items (I5) reach the chunk's rows, by Lemma S. An OCC
retry only changes which of the two cases applies.

**P3 (removal soundness).** After `f` is removed and the removal drained: no row
has a path naming `f`; every surviving row has a path all of whose facts exist;
and a row survives iff it has a lineage without `f`.

_Proof._ The first part is Lemma R; every remaining path's facts exist by Lemma
R again; a row with no path is deleted by `dropPath` and never written empty.
The third part is P2 with Lemma 0. ∎

**P4 (liveness).** Every expansion drains or leaves an `expansionFailures` row.
The only cursors dropped without a record are stale ones, and by Lemma Q nothing
is owed to them.

_Proof._ By I5 an item is finished or in the one continuation of the transaction
that holds it. The workpool calls `chunkCompleted` for every enqueued mutation.
On success the chunk's continuation (every item it did not finish, cursors
advanced) was committed with it. On failure or cancelation the chunk's writes
were rolled back, its continuation with them, and `chunkCompleted` re-enqueues
the identical cursor (I4: the same list) with half the budget, or after 5
attempts records it and logs it; stale items are dropped instead (Lemma Q (b)).
`chunkCompleted` reads its arguments, the active hash and the workpool's own
state, never the data its chunk read, so it cannot fail for the reason its chunk
did; it schedules one function, as every chunk does, so no chunk meets Convex's
per-mutation scheduling limit. `resumeExpansion` re-enqueues the stored items
and hash unchanged, with the budget reset to `writeBudget` and `attempts` to 0
(a fresh retry series); by P1 resuming is safe even if part of the work was
redone. Each successful chunk processes at least one entry or finishes at least
one item (§2.6: until it has, every budget check passes); every item spawned is
owed by a stored path or a scanned entry, both finite; ranges are finite and a
removal range only shrinks; so every chain ends. ∎

**Lemma B (the payload is bounded by the schema).** Let `R = |rules|`. In every
chain of continuations started by one write, at every step boundary of `execute`
(so in every continuation), the pending list holds at most

```
|L₀| + 3R + (H − 1)·R
```

items, where `L₀` is the write's seed list (§2.9: at most `3R` for
`addRelation`, `3R + |objectRelations|` for `setRelation`, 1 for
`removeRelation`, `deleteEntity` and `rebuild`, one per deleted fact of a
maintenance page; plus one owed `rebuild`) and `H` is the nesting height below.
On facts with no directed cycle, `H ≤ D`. In general, while the active config
does not change, `H ≤ 1 + D²·R`. An item is a few keys, except that `add/second`
carries at most `N + 1` path ids of at most `D` fact ids. For the app's schemas
(no fact cycle on a materialized walk, `D = 16`) a cursor holds at most
`|L₀| + 18R` items: a function of the config, never of the data.

_Proof._ _Structure._ The list is `G_h ++ … ++ G_1 ++ L`: `L` is a suffix of
`L₀` (its head possibly in progress), and each **group** `G_j` is what remains
of the items one entry of the head of the group behind it (`G_{j−1}`, or `L` for
`G_1`) spawned, that head kept right behind them. `execute` keeps this: a head
that finishes leaves its group (an empty group goes); a head that stops after a
spawning entry is put back with its spawn `S` in front, so `S` is a new group
`G_{h+1}` (§2.8); a stop changes nothing; the derive-to-retire hand-over
replaces an item of `L` in place.

_Group sizes._ An entry spawns at most `3R` items (§2.5), so `|G_1| ≤ 3R`. For
`j ≥ 2` the head of `G_{j−1}` is a spawned item, an add or `remove` item; a
`remove` spawns nothing, and an add entry changes one row, whose second-hop
items are at most `R`. So `|G_j| ≤ R`, and the list holds at most
`|L₀| + 3R + (h − 1)·R` items.

_Height._ For `j ≥ 2`, the items of `G_j` are `add/second(k_j, ρ, Π_j)`, `Π_j`
the paths one entry of `c_{j−1}` (the head of `G_{j−1}`) stored on `k_j`; for
`j ≥ 3`, `c_{j−1}` is itself an `add/second` and derives only from its carried
paths, so every `π ∈ Π_j` is `{f} ∪ p` with `p ∈ Π_{j−1}` and `f` a first-hop
fact. If `f ∈ p` (`p` a lineage of `(x, r, m)`, `f = (m, ρ.h, o)`), the
derivation of `p` uses `f` and arrives at `m`, so the facts walk from `o` back
to `m`: with `f`, a directed cycle. On acyclic facts `f ∉ p`, so
`min |Π_j| ≥ min |Π_{j−1}| + 1`, and `min |Π_2| ≥ 2` (a derived path); a path
has at most `D` facts, so `h ≤ D`. In general, trace one `π_h ∈ Π_h` back:
`π_j ∈ Π_j`, `π_{j−1} ⊆ π_j`, each stored on `k_j` at an event `t_j`, all rows
with one subject. The pairs `(k_j, π_j)` are distinct: if `(k_i, π) = (k_j, π)`
with `i < j`, `π` was not dominated at `t_j`, so it left `k_i` after `t_i`; by
I2 that is a deleted fact of `π` (then W refuses it at `t_j`), or pruning by a
current `σ ⊊ π` (which must leave before `t_j` too, and by induction on `|σ|`
that is again a deleted fact of `π`), never eviction or retire, since `π` is
current under the active config and only its steps run (Lemma Q); maintenance's
`deleteRow` aside. The sets `π_j` form a ⊆-chain, at most `D` distinct ones;
`k_j`'s object is the object of a fact of `π_h` (at most `D`) and its relation a
derived relation (at most `R`). So `h − 1 ≤ D·D·R`. (A config change and a
rollback during a chain can repeat a pair once per reactivation.) ∎

**P5 (depth).** No stored path has more than `D` facts, and the drained rows
depend on the facts only, not on write order.

_Proof._ `writePaths` is the only writer of derived paths and refuses `|π| > D`
(mirrors have 1 fact). The bound is in the definition of `Λ` (§1.2), and P2 says
the drained table is exact for `Λ_F`, which depends on `F` alone. Every attempt
to store a non-dominated path longer than `D` leaves an
`expansionFailures{depth}` row. ∎

**P6 (rebuild).** Let config `C` become active (which enqueues `rebuild` under
it, §2.9), and let that rebuild drain while `C` stays active. Then the table is
exact for `C`. This holds whatever ran before: another config, a rollback to `C`
from a later config, or old-config cursors still queued (Lemma Q drops them).

_Proof._ _Keys._ A rule key is `base@fingerprint`, where the base names the
rule's own content and the fingerprint hashes the bases of every rule reachable
through "my second hop reads your derived relation", itself included (CONTRACT
§5.1). So a key present in two configs denotes the same rule with the same
upstream rules, transitively; a path tagged with a key of `C` was written by a
rule of `C` from a second hop of a rule of `C` (add steps read current paths
only), and by I1 it is a derivation under `C`.

_Sound._ After `rebuild/retire` has passed a row, its paths are mirrors of
existing facts and paths of `C`'s rules with at most `D` existing facts, plus
what `writePaths` stored since (I1 under `C`). Every derived path written after
`C` became active is current under `C` (Lemma Q (a)) and satisfies I1 and W.
Every older non-current path was stored before the retire pass began, so retire
drops it. With Lemma R for later removals, Sound follows as in P2.

_Covering._ `rebuild/derive` ensures every mirror (I3) and creates
`add/first(f, ρ)` and `add/inverse(f, ρ)` for every fact; `ensureMirror` storing
a missing mirror also creates its second-hop items. Covering follows as in P2,
with `t_f` replaced by the event that creates these items: a current second-hop
path present then is read by Lemma S; one written later created its own
second-hop items. Retire drops only paths that are not current, too long, or
name a missing fact — none of which Covering relies on. Non-current paths do not
block a current path either: they are never dominating and never count against
the cap (§2.3). ∎

_Order._ Within the rebuild's own chain, phase derive's add work (nested items
included) finishes before `rebuild/retire` starts: derive hands over to retire
only when its scan is exhausted, and the pending list is depth-first (§2.8).
Work of other writes runs in other chains, which the workpool runs concurrently
and in no order. Retire therefore still protects readers itself: before it drops
a row's last path it re-derives one replacement from that path's own facts, so a
row that `C` derives from the same facts as before (a key change: every deploy
that edits an upstream arm) never disappears.

**P7 (the path cap).** A row holds at most `N` paths, plus its mirror. Only
current paths count against `N`; storing a current path evicts non-current ones
first (§2.3). When `writePaths` refuses a non-dominated path because the row
already holds `N` current paths, it records `expansionFailures{paths}`. Covering
then holds for every lineage except that one, so the row may be retracted early
(all its stored paths removed while the refused lineage still holds). `rebuild`
repairs such a row: retire keeps nothing to block it, and derive re-creates it
from the facts (P6). A config change never causes a `paths` failure by itself,
because the old config's paths are not current.

## 5. The budget of one transaction

A **unit** is at most one index range, two document reads and two document
writes. Costs (`|π|` is a path's fact count):

| operation                          | units                        | what it is                                                                                                                                                       |
| ---------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- | -------------------- | -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| a step's source read               | 1                            | one `get` or one row lookup                                                                                                                                      |
| one index fetch (a page)           | 1                            | one range; reads at most `min(256, room − 1)` documents                                                                                                          |
| one add entry                      | 1                            | the entry, the target row lookup, one row write                                                                                                                  |
| a stored path                      | `                            | π                                                                                                                                                                | `                               | `                                                                     | π                    | `fact`get`s (W) and `            | π                                                   | ` lineage inserts                                                                                                                              |
| a pruned or evicted path           | `1 +                         | σ                                                                                                                                                                | `                               | one `by_row` range, `                                                 | σ                    | ` lineage deletes                |
| a depth or paths failure           | 1                            | one insert                                                                                                                                                       |
| one remove entry                   | `1 +                         | π                                                                                                                                                                | `                               | the row `get`, one `by_row` range, `                                  | π                    | ` lineage deletes, one row write |
| one deleteEntity step              | 1 (2 on the object side) + 3 | `first()` of the subject range (then the object range); `deleteFact`: the fact delete, the mirror lookup, the mirror path's `by_row` range, delete and row write |
| one rebuild/derive fact            | 2 (+ `1 +                    | σ                                                                                                                                                                | `per path`ensureMirror` prunes) | the entry; the mirror and lineage-row lookups, at most one write each |
| one rebuild/retire row             | `1 + Σ                       | π                                                                                                                                                                | `+`                             | π                                                                     | `per kept path +`1 + | π                                | `per retired path (+ the replacement's`writePaths`) | the entry; per fact a `get`; per fact of a kept path a `by_row` lookup (`ensureLineage`) and at most one insert; per retired path a `dropPath` |
| the transaction's one continuation | 2, reserved up front         | the workpool's `enqueue` mutation: its globals read, the batch-worker ping, the `work` and `pendingStart` inserts                                                |

`execute` keeps `spent ≤ B − 2` before each entry. The exceptions are bounded:
the transaction's first entry always runs, and an entry's charges are made as it
writes (a step's source read, 1 unit, precedes its first check). So a
transaction overruns `B − 2` by at most one entry's cost plus 1: after an entry
overruns, every check fails and the loop stops at the next step boundary.

**Fetched but not processed.** A `scan` call's pages double from 2 while they
are read whole, so the last page it fetches holds at most 2 more documents than
all the entries it processed before, or at most the room left (then the
transaction ends): the documents a call fetches but does not process are at most
`2 +` the entries it processed. Stopping after a spawning entry therefore costs
at most 2 unprocessed reads per entry, which the entry's and the fetch's units
cover. `deleteEntity` reads one fact per step (`first()`), since every fact
spawns.

The largest entry, with `P = N + 1` paths on a row (P7) and every path of `D`
facts:

- **add entry**: `E_add ≤ 1 + 3P(D + 1)`. An entry derives at most `P`
  candidates (one per current path of its source row); each costs at most
  `D + 1` (the W reads, or the W reads and a `paths` record). Every path it
  drops (pruned or evicted) was on the row at the start (at most `P`) or was
  stored by this entry (at most `P`), each `1 + D`. That is 1,684 units with
  `D = 16`, `N = 32`, plus 2 per item it spawns (the changed row's second-hop
  items: one per rule reading its relation).
- **rebuild/retire row**: `E_retire ≤ 1 + P·D + P(1 + D) + D + P(1 + D)`. The
  classification reads each fact, each path is either kept (`ensureLineage`) or
  dropped (`1 + D`), and the one replacement costs `D` plus what it prunes or
  evicts (at most the row's `P` paths). An evicted path is charged again when
  retire drops it, so this overestimates. That is 1,667 units.
- **rebuild/derive fact**: `2 + P(1 + D)` = 563; **remove entry**: `1 + D` = 17;
  **deleteFact**: 3.

So `E = E_add` = 1,684, and a transaction spends at most `U = B + E + 1` units,
plus the caller's constant (the active-config and config reads or writes, the
fact lookup, the fact and mirror writes). This is also the worst transaction of
the depth-first order: one scan entry, its spawned items and a nested item's
range page all draw on the same budget, and only the entry in flight when it
runs out can overrun it.

With `B = 1000`: `U ≈ 2,690`. That is at most about 2,690 index ranges (limit
4,096, 66%) and 5,380 documents written (limit 16,000). Retire's worst case
(`1,000 + 1,667`) is below the add entry's, so its page size needs no extra cap.
Documents read are at most `2U` plus the fetched-but-unprocessed documents, at
most 2 per entry plus the room left when the transaction stops (above): at most
`4U`, far under 32,000. Bytes written: a row write is three keys plus at most
`N + 1` paths of at most `D` ids of 32 bytes. That is about 17 KiB in the worst
case and a few hundred bytes for the app's 2–3-fact, 1–2-path rows. A
transaction writes at most `U/2` rows, so the 8 MiB limit is reachable only by
rows near both caps. A chunk that exceeds a limit fails, and P4 retries it with
half the budget. The first entry alone is far under every limit. The payload
(Lemma B) is at most `|L₀| + 18R` items of a few hundred bytes for the app's
schemas, and a chunk schedules one function (limit 1,000).

**Continuations per expansion.** A continuation stops only when a check fails,
i.e. with less room than the largest check (`1 + D`, a remove entry), so every
continuation but the last spends at least `B − 3 − D` units. An expansion of `W`
units takes at most `⌈W / (B − 3 − D)⌉ + 1` continuations beyond the caller's
transaction: about `k·n / B` for `n` rows at `k` units each. The incident's
rebuild (§6, `scale.test.ts`: `n` facts `(S, parent, Dn)` plus `(S, source, R)`,
mirrors missing, one inverse rule) costs `k = 17` per parent fact: derive 3 (its
share of a 2-entry fetch, the entry, the mirror), its `add/inverse` 5 (the
source `get`, one short fetch, the entry, a 2-fact path), retire 8 (its mirror
row 3, its derived row 5), and 1 as an entry of `R`'s `add/first`, which finds
every row already stored. At `B = 1000`, `n = 5,000` took 85 continuations
(`ZBAR_SCALE=5000`; the suite's bound `⌈5001·17 / (1000 − 19)⌉ + 2` is 89, the
coarser `⌈5001·17/1000⌉ + 5` is 91); the permanent run, `n = 500` at `B = 200`,
takes 43 (bound 50).

## 6. What the tests check

One test per proposition, each on a schema where it can fail, with
`GraphConfig`s written by hand (or compiled, where the claim is about the
compiler). "Reference" is a pure evaluator of §1.2 in
`src/client/tests/expansion-harness.ts` (fixed point over the facts, minimal
lineages), which shares no code with the engine. `expectExact` checks Lemma 1's
conclusion (row keys, `paths(k) = Min Λ_F(k)`), Sound per path, and L exactly.
The parked-cursor driver (`mockWorkpool: true`) lets a test choose which chunk
runs next.

| claim                | test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1                   | `tests/engine.test.ts`: run each of the first parked cursors twice in a row; the table is identical after the first and the second run, and the drained state equals the reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P2                   | `race.test.ts`: 40 random adds, removals, `setRelation`s and `deleteEntity`s over a schema with a chained expands, a recursive walk with cycles and self-loops, and a rule whose second hop is a materialized relation and an inverse arm, at `writeBudget: 2`, with parked chunks run between the writes and at the end under FIFO, LIFO, seeded random, removals-first and additions-first schedules; drained, `expectExact`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P3                   | `consistency.test.ts`: after a removal drains, no path names the fact and every row has a live path; a row with two lineages survives losing one and goes with the second; two removals that share a path, under every schedule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| W                    | `consistency.test.ts`: a link removed while a walk is parked mid-flight — after EVERY chunk, under every schedule, the stored paths naming the deleted fact are a subset of those present at its deletion, and L holds; an add cursor whose source path names a deleted fact writes nothing from it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| L, Lemma R           | `consistency.test.ts`: a fact removed under config A (which has no rule for them) retracts rows only config B derives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P4                   | `mutations.test.ts`: a continuation (an add) whose config hash is unknown fails 5 times under the real workpool, lands in `expansionFailures` with its cursor (budget halved to 1), and `resumeExpansion` completes it once the config is registered; a depth failure is recorded and is not resumable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Lemma B, P4 at scale | `scale.test.ts`, the dev incident: `N = 500` at `B = 200` (7 s); `ZBAR_SCALE=5000 npx vitest run src/client/tests/scale.test.ts` runs it as it happened, `N = 5,000` at `B = 1000` (minutes: convex-test walks every document per index query). (a) `rebuild` over `N` imported `(S, parent, Dn)` facts and `(S, source, R)` under the real workpool drains to `N` derived rows, a mirror per fact, L exact, no failure, in at most `⌈(N+1)·17 / (B − 3 − D)⌉ + 2` continuations, every payload within `3R + 17`; (b) `addRelation(S, source, R)` over `N` existing parent facts writes at most `B` rows in the caller's transaction and parks ONE continuation, and the drain (never more than one parked) ends in (a)'s state; (c) then `deleteEntity(system:S)` leaves no fact, row or lineage row, one continuation per chunk; (d) 200 (1,000 under the flag) `(S, source, R_i)` facts over 2 devices: the longest parked list stays within `3R + 17`. A payload of the previous engine version (an unreadable envelope, an `add/second` without `paths`) is dropped with a warning; the old `{ item }` envelope still runs |
| P5                   | `tests/engine.test.ts`: a recursive chain longer than `maxDepth`, written in both orders, gives the same rows, no path over `D`, and one depth failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| P6                   | `tests/engine.test.ts`: an arm going from materialized to computed retires exactly its rule's paths and back again restores the reference; an upstream-only schema edit changes the downstream rule's key (same base) and `rebuild` leaves the table exact for the new config; `rebuild` after `maxDepth` is lowered drops every path over the new bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Lemma Q, P6          | `tests/engine.test.ts` "Lemma Q": A = {TEAM, ORG} → B = {TEAM} → A, each switch by a write alone (A already registered on the way back): each switch parks exactly one `rebuild` and the drained table is exact for the active config (the ORG rows go, then come back); the reverse B → A → B leaves no ORG row; facts with no active row rebuild on the first write. Probe B: C1 derives `(u viewer o)` from `{a, b}`, C2 only from `{a, b, c}`; a C1 `add/second` cursor parked at `writeBudget: 1` before C2 became active, run before and after C2's retire passes the row, writes nothing, and the drained table is exact for C2 with no failure recorded (run, it prunes C2's `{a,b,c}` and leaves a stale `{a,b}`, or the row vanishes). A stale cursor is dropped by `chunkCompleted` (no retry, no record) and by `resumeExpansion` (record deleted, nothing enqueued)                                                                                                                                                                                                                                                |
| P7                   | `tests/engine.test.ts`: `N + 1` lineages for one row store `N` and record a `paths` failure; removing the stored paths' facts retracts the row early; `rebuild` re-derives it. `N` paths of an old config on a row, a new config deriving it once: before retire the row holds `N` paths including the new one (one old path evicted), after it exactly the new one, and no `paths` failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| §4.7 parity          | `parity.test.ts` "the depth rule is one rule": a computed refusal is accepted only with a depth failure on the read's own row or on a row its derivation passes through, and every depth failure sits on the row of a refused read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| seed                 | `tests/engine.test.ts`: inside one mutation, a read after `insertFact` sees the fact and its mirror; a read after `deleteFact` does not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Each of these deliberate bugs makes at least one test fail: no lineage rows for
a stored path, a `remove` that stops after one page, deriving from non-current
paths, no W check in `writePaths`, an off-by-one depth guard, a cursor that
skips the rest of its range, a cap that is not enforced, a cap that counts
non-current paths, no eviction, a rebuild only on a NEW hash (not on a
rollback), a stale cursor that runs, and a transaction that enqueues its
leftover items as separate continuations.
