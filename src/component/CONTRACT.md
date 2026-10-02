# convzibar engine contract (v2)

This file is the single definition that the schema builder, the compiler, the
read-time planner and the write-time BFS implement. The design rationale and the
app schema are in `docs/specs/zbar-schema-proposal.md`; the proofs of §5 are in
`EXPANSION.md` next to this file. If code and this file disagree, the code is
wrong.

## 1. Facts

A **fact** is `(subject: type:id) —relation→ (object: type:id)`, stored once in
`relationships` with optional `properties`. Indexes:

- `by_subject_relation_object (subjectType, subjectId, relation, objectType, objectId)`
- `by_object_relation_subject (objectType, objectId, relation, subjectType, subjectId)`

Facts are the only thing a caller writes. Every fact is also mirrored into
`effectiveRelationships` as a row with path
`{ baseIds: [factId], rule: 'fact' }` so that a relation with materialized arms
is one index range. Every stored path (mirror or derived) has one `lineage` row
per fact it names (§5.5).

## 2. Sets and arms

A **set** is a relation or a permission on an entity type. A relation is
writable (facts may be written to it); a permission is not. A set is the union
of its **arms**:

| Arm      | Written            | Meaning                                                                                                                             |
| -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| facts    | `'system_user'`    | subjects of this type written as facts of this set                                                                                  |
| inherits | `'admin'`          | everything in `admin` (a relation or a permission on the same entity)                                                               |
| expands  | `'group#viewer'`   | for each `group` in the **first hop** of this set, that group's full `viewer` set; `group` becomes a writable fact type of this set |
| walks    | `'parent.admin'`   | for each object in the **first hop** of `parent` (per declared type), that object's full `admin` set                                |
| inverse  | `'~device#parent'` | the `device` nodes `x` with a fact `(thisObject, parent, x)`                                                                        |

Wrapping an expands or walks arm in `materialize(arm)` makes it materialized
(§5). Every other arm is computed. Facts, inherits and inverse arms are never
materialized (facts are mirrored; inherits is resolved by both evaluators from
`inherits`; inverse is one facts-index range). An arm is a string or
`materialize(string)`; nothing else is an arm. A name is declared once per
entity.

### 2.1 First hop (walks, expands)

The first hop of an arm on set `(O, R)` reads **facts only**:

- expands `T#t`: facts `(m:T, r, o:O)` for every `r ∈ factRelations[O][R]`.
- walks `via.t` with declared via type `V`: facts `(m:V, r, o:O)` for every
  `r ∈ factRelations[O][via]`.

`factRelations[O][R]` = the writable relations in the inherits closure of `R`
(so `operator ⊇ admin` means the first hop of `group#viewer` on `operator` reads
`operator` facts and `admin` facts). Derived rows are never a first hop.

### 2.2 Second hop

The second hop reads the **full set** `t` on the intermediate type `T`: its
inherits closure, every arm, computed or materialized, recursively. Concretely
the planner evaluates `planSet(T, t)`; the BFS reads `effectiveRelationships`
rows with relation in `rules[].secondHop.relations` plus the inverse ranges in
`rules[].secondHop.inverses` (§5.1 restricts what a materialized second hop may
contain).

### 2.3 What may reference what

- `inherits` may name a relation or a permission on the same entity.
- `walks` may target a relation or a permission on the via type.
- `expands` (`T#t`) may target a **relation only**. `T#permission` is a schema
  error: permissions are checkable, never grantable, and `#` is the
  grant-expansion operator. (Rationale in the proposal, §"permissions".)
- `inverse` names a relation on the other type.
- A permission may have inherits, walks and expands arms, never facts.
- Entities may be declared in any order; names resolve at `build()`.

### 2.4 Local inheritance

`inherits[O][S]` = `S` plus every set it transitively inherits. Both evaluators
resolve a read of `S` as "any row/plan of a set in `inherits[O][S]`".
Inheritance is never a row.

## 3. Reads

All reads compile the same plan from `sets`:

- `can(subject, permission, object)`,
  `hasRelationship(subject, relation, object)`
- `getPermissions(subject, object)`
- `list().object(type).{relation|permission}(x).subject(s)` → objects
- `list().object(o).{relation|permission}(x).subject(type)` → subjects
- `.via(...)`: boundary relations and candidate expansion derived from the same
  compiled arms through the same planner.
- `listDirect()`: facts only, with properties. For a set with inverse arms it
  returns the underlying facts flipped (`subject` = the inverse node, `relation`
  = the set's name, `object` = this object).

Evaluation of an arm at read time:

- facts / materialized rows: `effectiveRelationships` by
  `by_subject_relation_object` (forward) or `by_object_relation_subject`
  (reverse), relation ∈ closure.
- expands/walks (computed): first hop = facts (§2.1) via the facts indexes;
  second hop = `planSet(T, t)` recursively.
- inverse: one range on the facts index `by_subject_relation_object` with prefix
  `(thisType, thisId, relation, subjectType)`.
- recursive sets: the planner computes its own strongly connected components
  over the computed walks/expands arms (it must know which arms re-enter a
  component; the compiler stores no recursion flag). A set in a component is a
  `Closure`: frontier iteration with a visited set, at most `maxDepth` steps.
- every set whose `maxLineage` is null (§4.7) is answered by fact count.

Every index range a read issues returns at most `RANGE_LIMIT` = 8,192 documents;
a range over more **throws** ("range over N rows; narrow the query") rather than
answering from a truncated range. A key-type range is the half-open
`[type + ':', type + ';')`: `keys.ts` `prefixRange` / `typeRange`, the one
encoding of a key-prefix range (reads and maintenance).

## 4. The invariant

**Materialization never changes an answer.** For any schema and any set of
facts, moving any walks/expands arm between computed and `materialize()` leaves
every read in §3 unchanged once materialization has caught up (§5.4), for every
answer within the bound of 4.7. Stated so a test can check it:

1. **Typed graph.** A node is `(type, id)`. An arm derives only through
   intermediates of the type it names; names resolve per type, never across
   types.
2. **First hop reads facts** (§2.1). Derived rows are never a first hop.
3. **Second hop reads the full set** (§2.2).
4. **Inverse** `~T#r` on `o` is exactly `{ x:T | fact (o, r, x) }`.
5. **Inherits** is resolved at read time by both evaluators from `inherits`.
6. **Mixed arms.** A materialized arm's second-hop closure may contain facts,
   inherits, inverse arms and materialized arms. If it contains a computed
   walks/expands arm the compiler rejects the schema: "materialize that arm too,
   or compute this one".
7. **`maxDepth` bounds the number of facts in a derivation's lineage, on both
   sides, by one rule.**
   - _Static._ The compiler gives every set `maxLineage`: the most facts one
     derivation can use, over every arm whether computed or materialized (facts
     and inverse 1; walks/expands 1 + the far set's), or null when the set
     reaches a cycle. A finite `maxLineage` above `maxDepth` is a schema error
     at load. So acyclic chains never meet the bound at runtime.
   - _Write side._ The BFS never stores a path of more than `maxDepth` facts; it
     records `expansionFailures{depth}` instead.
   - _Read side._ A set with a null `maxLineage` is answered by fact count: each
     answer's fewest-facts derivation found (a fact counts 1, a row its shortest
     stored path, a computed walk/expansion 1 + its far set's, a recursive step
     1). Within `maxDepth` facts it counts; when the only derivations found are
     longer, the read **throws**; when none is found the answer is no. A
     `Closure` looks at most `maxDepth` steps away; it never throws merely
     because its frontier reached that bound with no hit. The rule is the same
     for `check`, `checkBatch`, `expandObjects` and `expandSubjects`.
   - _Parity._ The read side counts facts along a derivation's path; the write
     side counts the distinct facts of its lineage, which is never more. So
     whenever the read side answers (does not throw), it agrees with the write
     side. When it refuses, the write side has a depth failure on record for
     that derivation or for a prefix of it: a row the derivation passes through,
     whose refusal kept the write side from ever attempting the longer
     derivation. The other case is a derivation whose path uses one fact twice
     (a cycle in the facts at exactly the bound), which the write side stored. A
     recorded depth failure thus marks where the two sides differ, with that one
     exception.
8. **Recursion** is accepted for both kinds of arm. Nothing is silently
   truncated: past the bound a read throws or a write records a failure. **Lists
   are sets.** `list()` results are deduplicated ids; order is unspecified. Via
   types of a walk are the fact subject types of the via relation and of every
   relation it inherits.
9. **`.via()`** uses the same compiled arms through the same planner.
10. **Eventual.** The invariant holds once the expansion for the affected facts
    has drained and no chunk has failed. Failed chunks are recorded and
    resumable. A config change is followed by a `rebuild` (§5.6, automatic).

The parity test (`src/client/tests/parity.test.ts`) runs every fixture under
"all computed" and "all eligible arms materialized" and compares every read; its
depth cases check 4.7: equal answers, or a computed throw with a depth failure
on record on the read's own row or on a row its derivation passes through; and
every depth failure sits on the row of a refused read.

## 5. Materialization (the BFS)

### 5.1 Rules

The compiler flattens every materialized arm into `TraversalRule`s (`types.ts`):
one per `(arm, firstHop.relation ∈ factRelations, intermediateType)`. Both arm
kinds produce the same rule shape:

```
fact (M:intermediateType, firstHop.relation, O:objectType)            first hop
row  (S, r, M)  with r ∈ secondHop.relations                             second hop
  or fact (M, q, S:T) with {T, q} ∈ secondHop.inverses
⇒ derived row (S, derived, O), path { baseIds: lineage(fact) ∪ lineage(row), rule: key }
```

`secondHop.relations` is the target set's inherits closure restricted to
writable relations plus relations with materialized arms (whose rows exist);
`secondHop.inverses` are the inverse arms in that closure. Invariant 6 holds by
construction: nothing else may appear.

**Keys.** `key = base@fingerprint`. The base names the rule's own content:
`O.derived<=firstHop:I#target(secondHop.relations;secondHop.inverses)`. A rule ρ
_reads_ a rule σ when σ derives a relation on ρ's intermediate type that ρ's
second hop reads; the fingerprint is FNV-1a of the sorted bases of every rule
reachable from ρ that way, ρ included (so a recursive group of rules is hashed
as one closed set). An edit anywhere upstream of a rule therefore changes its
key, and `rebuild` retires the rows it no longer justifies.

### 5.2 Triggers and writes

Every change of an effective row `(x, r, y)` is examined once:

- **First-hop trigger** (when the change stored the mirror of fact `f`): for
  each rule with `objectType = y.type`, `firstHop.relation = r`,
  `intermediateType = x.type`: read the second hop of `x` (rows with relation ∈
  `secondHop.relations` via `by_object_relation_subject` on x; inverse ranges on
  the facts index) and derive `(S, derived, y)` for each.
- **Second-hop trigger** (any change): for each rule with
  `intermediateType = y.type` and `r ∈ secondHop.relations`: read the facts
  `(y, firstHop.relation, o:objectType)` via `by_subject_relation_object` on y
  and derive `(x, derived, o)` from every path of the row, for each.
- **Inverse trigger** (when the change stored a mirror): for each rule with
  `intermediateType = x.type` and `{y.type, r} ∈ secondHop.inverses`: read the
  facts `(x, firstHop.relation, o)` and derive `(y, derived, o)` for each.

A trigger derives only from **current** paths: mirrors and paths whose rule is a
key of the config it runs under. A derived path is written only if, in order: no
current stored path's lineage is a subset of it (else it adds nothing); it has
at most `maxDepth` facts (else `expansionFailures{depth}`); every fact it names
exists now, read in the writing transaction (Invariant W); and the row then
holds at most `MAX_PATHS` = 32 current paths (else `expansionFailures{paths}`,
the row kept as it is). Only current paths count against the cap: a path of
another config never blocks a current one, and storing a current path evicts
non-current paths while the row would exceed the cap, so a row holds at most
`MAX_PATHS` paths plus its mirror. Storing it prunes the row's stored supersets
of it, so a row's paths are an antichain. Only a changed row is examined for
further triggers.

A row whose path was refused for the cap is missing one lineage: it may be
**retracted early** (all its stored paths removed while the refused lineage
still holds). `rebuild` re-derives it (§5.6).

### 5.3 Budget and cursor

`writeBudget` (component config, default 1000) is the number of budget units one
transaction may spend; a unit is at most one index range, two document reads and
two document writes (`EXPANSION.md` §5 has the cost of every operation and the
limit arithmetic). The seed fact and its mirror are always written in the
caller's transaction. Trigger evaluation then proceeds **depth-first** over a
pending list of work items (`EXPANSION.md` §2.7: the kind, the source fact or
row, the rule key, the paths it owes, the last index key): the items an entry
spawns run before the item that spawned it moves to its next entry, so a fact's
derived work finishes before a scan moves on.

**One chunk, one continuation.** When the budget is reached, the unfinished part
of the list is handed to the workpool as ONE **cursor**, never as a row list and
never as one work item per spawned item:
`{ items, configHash, budget, attempts }`, where `items` are the
not-yet-finished items, head first, each in-progress one carrying its own index
cursor, and `configHash` is null for a removal started by maintenance (removal
reads no rule). A transaction (the caller's or a continuation) enqueues at most
one continuation, and `items` is bounded by the schema, not the data
(`EXPANSION.md` Lemma B: at most the seed list plus `3·|rules|` plus `|rules|`
per nesting level, with at most `maxDepth` levels on acyclic facts). Each
continuation is one mutation that runs the list under its budget, writes what
does not yet exist, and enqueues the rest or finishes; a failed chunk is retried
with the same list (§5.7). A continuation payload of a previous engine version
is read defensively: an item it does not recognize is dropped with a warning,
and `rebuild` re-derives what it owed. The same mechanism serves removal (§5.5),
`deleteEntity` and `rebuild`.

### 5.4 Correctness without locks (the proof obligation)

`EXPANSION.md` states, as propositions with proofs:

- **W** A path is written only by a transaction that read every fact it names
  and found it present.
- **L** `lineage` holds exactly one row per (fact f, row, stored path p) with f
  ∈ p, maintained in the same transaction as the path.
- **P1 Idempotence.** Running a chunk twice yields the same rows.
- **P2 Order independence.** The final effective graph after all chunks of all
  concurrent writes have drained equals the least fixed point of the rules over
  the facts, regardless of interleaving (via Convex serializability), unless a
  `paths` failure was recorded (P7).
- **P3 Removal soundness.** After a fact is removed and its removal drained, no
  row carries a path naming it, and every surviving row has a path all of whose
  facts exist.
- **P4 Liveness.** Every expansion either drains or leaves an
  `expansionFailures` row; no silent drop.
- **P5 Depth.** No written path exceeds `maxDepth`; the bound is a function of
  the facts, not of write order.
- **Q Active config.** Only the active config's add and rebuild work runs; a
  cursor of another config is dropped, and nothing is owed to it.
- **P6 Rebuild.** After the `rebuild` a config change enqueues drains, while
  that config stays active, the table is exact for it, whatever ran before
  (another config, a rollback, old cursors still queued).
- **P7 Cap.** A row stores at most `MAX_PATHS` current paths (plus its mirror);
  exceeding it is recorded, and `rebuild` repairs an early retraction.

### 5.5 Removal

Removing fact `f`: delete the fact, drop its mirror path, then, by cursor over
`lineage.by_fact(f)`: for each entry `(row, path)`, drop that path from the row
with all its lineage rows, and delete the row when no path remains. The range is
re-read from its start (processed entries leave it) until it is empty. **No rule
is read**: every transitive dependent of `f` has `f` in its lineage, so one
range finds them all, whatever config wrote them and whatever config the removal
runs under. Completeness follows from L, W and serializability (`EXPANSION.md`
Lemma R).

`deleteEntity` deletes, by cursor, every fact touching the entity (subject side,
then object side), each with the same removal. `setRelation` adds the new fact,
then removes the others, in one transaction, and runs the add work before the
removal work: a row that both the old and the new fact derive gains its new path
before it loses its old one, so readers see rows fill in and never see one both
facts derive disappear.

### 5.6 Rebuild

`rebuild({ configHash })`, by cursor, in two phases:

1. **derive**: for every fact, ensure its mirror and lineage row, and run its
   first-hop and inverse triggers (depth-first, §5.3). Retire starts when
   derive's own work has drained; work of concurrent writes runs in other
   continuations, in no order, so their paths are NOT guaranteed to land before
   retire reaches a row.
2. **retire**: for every row, drop every path whose rule is absent (v1) or not a
   key of the config, whose lineage exceeds `maxDepth`, or that names a fact
   that does not exist (a `'fact'` path counts only as its own fact's mirror).
   Before a row loses its last path, re-derive one replacement from the dropped
   paths' own facts under the config (`derivationsWithin`, in memory), so a row
   the config still derives from the same facts never disappears. This
   re-derivation, not the order of phases, is what protects readers; the full
   set of lineages comes from phase 1's add work. Kept paths get any missing
   lineage row (`ensureLineage`). Rows left empty are deleted; a mirror of an
   existing fact always stays.

Idempotent and resumable. **Automatic:** the component records one **active**
config hash (`activeConfig`). Every write first makes its own config active;
when that changes the active hash (a deploy that changed the schema, or a
rollback to an earlier one) the same transaction enqueues a `rebuild` under it,
so the table is repaired without an operator. The first write on a fresh
component (no active hash, no fact) enqueues nothing. **Old cursors:** a queued
add or rebuild cursor whose config is not the active one is dropped when it runs
(`EXPANSION.md` Lemma Q), so in-flight work of the previous config can neither
store an old-key path nor prune a new one; the active config's rebuild
re-derives from every fact, so nothing is owed to it. Removal cursors read no
rule and always run.

### 5.7 Failures

A chunk that fails is re-enqueued (the same list) with half its budget up to 5
attempts, then an `expansionFailures` row
`{ cursor, error, attempts, reason: 'failed' | 'canceled' }` is written and
`console.error`'d. The add and rebuild items of a failed cursor whose config is
no longer active are dropped instead (§5.6). `resumeExpansion` re-enqueues the
recorded items with the budget and attempt count reset. `depth` and `paths` rows
record a refused derivation (§5.2); they are not continuations and are repaired
by `rebuild`. `listExpansionFailures` (query) and `resumeExpansion` (mutation)
are **component-public** functions, exposed through the client as
`zbar.listExpansionFailures` / `zbar.resumeExpansion`.

## 6. Component configuration

The expansion pool runs one chunk at a time (`workpool.ts` `maxParallelism: 1`):
concurrent chunks over the same rows only retry each other under OCC, and a
serial pool keeps the proofs' "given the facts now" reading literal.

```ts
createZbar(components.convzibar, {
  schema,
  writeBudget: 1000, // budget units per transaction before continuing in the workpool
  maxDepth: 16, // the most facts in one derivation's lineage (§4.7)
});
```

Both are compiled into the config (and its hash). `GraphConfig.mockWorkpool` is
a test-time driver: every cursor is parked in the `mockWorkpool` table (which
exists only under `NODE_ENV=test`) so a test chooses which chunk runs next; the
proofs of `EXPANSION.md` §6 interleave chunks this way.

`asyncWrites`, `maxChunkSize`, `maxWriteDepth` and `readTimeChainDepth` no
longer exist; neither do the builder's `.extend`, `.readTimeRelation` and the
`{ type }` / `{ type, reverse }` arm objects.
