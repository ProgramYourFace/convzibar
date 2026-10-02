# Convzibar (Convex x Zanzibar)

A Zanzibar-style relationship-based access control (ReBAC) engine for Convex,
shipped as a Convex component plus a strictly typed client.

You write **facts** (`user:ana —admin→ team:core`). A schema declares, per
entity, how each relation and permission is built from those facts. Every read
(`can`, `getPermissions`, `list`, `.via`) compiles the schema into one plan and
answers from the indexes. Each derived arm is **computed at read time** by
default. You can opt a single arm into **write-time materialization**, which
moves its work from reads to writes.

> **Materialization never changes an answer.** Every read returns the same
> result whether an arm is computed or materialized. This holds for `can`,
> `hasRelationship`, `getPermissions`, `list()` in both directions and `.via()`.
> The parity test (`src/client/tests/parity.test.ts`) runs every fixture both
> ways and compares every read.

The formal definition of the engine is
[`src/component/CONTRACT.md`](./src/component/CONTRACT.md). The algorithm and
proofs for the write path are in
[`src/component/EXPANSION.md`](./src/component/EXPANSION.md). If this README and
the contract disagree, the contract is correct.

## Installation

This package is distributed directly from GitHub (not the npm registry). Install
a tagged version:

```bash
bun add github:AllAware/convzibar#v3.0.0
# or
npm install github:AllAware/convzibar#v3.0.0
```

If the repo is private, see [PUBLISHING.md](./PUBLISHING.md) for how to give
your CI/CD build access with a fine-grained PAT.

Register the component in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import zbar from "convzibar/convex.config";

const app = defineApp();
app.use(zbar);
export default app;
```

The component mounts `@convex-dev/workpool` internally for its write
continuations. You do not need to install or register it yourself.

## Quick start

```ts
// convex/zbar.ts
import { createZbar, createZbarSchema } from "convzibar";
import { components } from "./_generated/api";

export const zbarSchema = createZbarSchema()
  .entity("user")
  .entity("team", (e) =>
    e
      .relation("admin", "user")
      // members: the admins, users written as member, and the members of any
      // team written as a member here (nested teams)
      .relation("member", "admin", "user", "team#member"),
  )
  .entity("folder", (e) =>
    e
      .relation("parent", "folder")
      .relation("editor", "user", "team#member", "parent.editor")
      .relation("viewer", "editor", "user", "team#member", "parent.viewer")
      // the documents whose `folder` fact points at this folder
      .relation("documents", "~document#folder")
      .permission("edit", "editor")
      .permission("view", "viewer"),
  )
  .entity("document", (e) =>
    e
      .relation("folder", "folder")
      .relation("owner", "user")
      .permission("edit", "owner", "folder.editor")
      .permission("view", "edit", "folder.viewer"),
  )
  .build();

export const zbar = createZbar(components.convzibar, { schema: zbarSchema });
```

`new Zbar(components.convzibar, options)` is equivalent to `createZbar`. Both
are generic over the schema, so entity types, relation names and permission
names are checked and autocompleted without codegen.

## The schema

### Facts and sets

A **fact** is `(subject type:id) —relation→ (object type:id)`. Facts are stored
once, are indexed from both ends, and may carry typed properties. Facts are the
only thing you write.

A **set** is a relation or a permission on an entity type. A relation accepts
facts. A permission accepts none and is otherwise identical: it is a union of
arms that you check. Relations and permissions on one entity share one
namespace. Entities may be declared in any order because names resolve at
`build()`. An entity with no callback (`.entity("user")`) is a pure subject.

### The five arms

A set is the union of its **arms**. Every arm is a string:

| Arm      | Written              | Adds to the set                                                                                               |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| facts    | `"user"`             | subjects of this type written as facts of this set                                                            |
| inherits | `"admin"`            | everything in `admin`, a relation or permission on the same entity                                            |
| expands  | `"team#member"`      | for each `team` in the **first hop** of this set, that team's full `member` set; `team` becomes writable here |
| walks    | `"parent.editor"`    | for each object in the **first hop** of `parent`, that object's full `editor` set                             |
| inverse  | `"~document#folder"` | the `document` nodes `x` that have a fact `(thisObject, folder, x)`                                           |

How to read the syntax:

- `.` means "go through one of _my_ relations to another object, then take a set
  there".
- `#` means "go through the _subjects already in this set_, then take a set
  there".
- `~` flips an edge. `~document#folder` on a folder is the set of documents that
  name this folder as their `folder`. It is one index range over facts.

**Two hops.** Expands and walks each have two hops:

- The **first hop reads facts only**: the facts of the named relation and of
  every writable relation it inherits. On `folder.viewer` above, `team#member`
  finds a team written as `viewer` **or** as `editor`, because `viewer` inherits
  `editor`. One fact per tier is enough, and nothing needs to be written twice.
- The **second hop reads the full far set**: its inherits closure and every arm,
  recursively. On `team#member`, that includes the team's admins and its nested
  teams.

Derived results are never used as a first hop. Inverse arms read facts only.

**What may reference what.**

- Inherits may name a relation or a permission.
- A walk may target a relation or a permission on the via type.
- An expands arm (`T#t`) may target a **relation only**. `T#permission` is a
  schema error. Permissions can be checked but never granted, and `#` is the
  grant-expansion operator. To reach a permission on the far side, use a walk.
- An inverse arm names a relation on the other type.
- A permission may have inherits, walks, expands and inverse arms. It may never
  have a facts arm.

Use a permission when a walk must not enter a relation. In this example, team
viewers stay "the members", while org admins can still manage every team:

```ts
.entity("team", (e) =>
  e
    .relation("org", "org")
    .relation("member", "user")
    .permission("manage", "member", "org.admin"), // org admins are not members
)
```

### Recursion and depth

Recursive sets are allowed for computed arms, for example `parent.editor` on a
folder tree or `team#member` for nested teams. The read planner evaluates a
recursive component as a closure with a visited set. The closure takes at most
`maxDepth` steps.

`maxDepth` (default 16) bounds the number of facts in any one derivation, on
both the read side and the write side, by one rule:

- **Acyclic chains are checked when the schema loads.** If the longest
  derivation of a set uses more than `maxDepth` facts, the constructor throws.
  Acyclic chains therefore never reach the bound at runtime.
- **Writes** never store a longer path. Instead they record an
  `expansionFailures` row with reason `depth`.
- **Reads** of a recursive set throw when the only derivations they find are
  longer than `maxDepth`. They answer "no" when they find none.

Nothing is truncated silently.

### Materialization

Wrap an expands or walks arm in `materialize()` to keep that arm's contribution
as rows. The relation then becomes one index range to read:

```ts
import { createZbarSchema, materialize } from "convzibar";

createZbarSchema()
  .entity("user")
  .entity("team", (e) => e.relation("member", "user"))
  .entity("project", (e) =>
    e
      .relation("team", "team")
      .relation("viewer", "user", materialize("team.member"))
      .permission("view", "viewer"),
  )
  .build();
```

The rules for `materialize()`:

- Facts, inherits and inverse arms are never materialized. Facts are mirrored
  into the same table. Inherits is resolved by name. An inverse arm is already
  one range.
- Only relations may materialize arms. Permissions receive no writes, so they
  have nothing to store.
- **Mixed arms.** The second hop of a materialized arm may contain facts,
  inherits, inverse arms and other materialized arms. It may not contain a
  computed walk or expansion. The compiler rejects that schema with "materialize
  that arm too, or compute this one".

Choosing between the two:

| Choose          | When                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| computed        | Default. Read cost grows with the **first-hop fan-in** on the object side (parents, groups). Reactive queries are fine with a few ranges.                |
| `materialize()` | A hot read path that must be one index range. Write cost grows with the **second-hop fan-out** (members per group), plus storage and a staleness window. |

You can switch an arm between computed and materialized at any time: edit the
schema and deploy. Answers do not change, and the component rebuilds the derived
rows by itself (see [Writes](#writes)).

### Properties

Typed properties on a relation's facts use Convex validators. The client
validates them on write, and `listDirect()` returns them:

```ts
import { v } from "convex/values";

.entity("alert", (e) =>
  e
    .relation("recipient", "user", "team#member")
    .properties("recipient", {
      push: v.boolean(),
      email: v.optional(v.boolean()),
    }),
)
```

## Reads

All reads take a `QueryCtx` or an `ActionCtx`. Subjects can be any entity type,
not only users.

```ts
const ana = { type: "user" as const, id: anaId };
const doc = { type: "document" as const, id: docId };

await zbar.can(ctx, ana, "edit", doc); // permission → boolean
await zbar.hasRelationship(ctx, ana, "owner", doc); // relation → boolean
await zbar.getPermissions(ctx, ana, doc); // ["edit", "view"], declaration order
```

`hasRelationship` checks the full set, including inherited, expanded and walked
members. It does not only check whether a fact exists. To check facts alone, use
`listDirect()`.

### `list()`

`list()` enumerates either side of a set. Results are deduplicated ids in
unspecified order.

```ts
// objects: every document ana can view
const docs = await zbar
  .list()
  .object("document")
  .permission("view")
  .subject(ana)
  .collect(ctx); // [{ objectId }]

// subjects: every user who can edit this folder
const editors = await zbar
  .list()
  .object({ type: "folder", id: folderId })
  .relation("editor")
  .subject("user")
  .collect(ctx); // [{ subjectId }]

// .map() runs per item before collect
const titles = await zbar
  .list()
  .object("document")
  .permission("view")
  .subject(ana)
  .map(
    async ({ objectId }) =>
      (await ctx.db.get(objectId as Id<"documents">))?.title,
  )
  .collect(ctx);
```

### `.via()`

`.via(...entities)` scopes a list to the structural neighbourhood of pinned
entities. It returns **exactly the full list intersected with the structural
scope**:

- Two nodes are structurally linked when a **fact** connects them on a relation
  that the compiled arms declare between their types. The relations that count
  are facts and expands subject types, the via relation of a walk, and the
  relation an inverse arm reads.
- When you list objects, candidates are the structural neighbours of the last
  via. When you list subjects, candidates are the neighbours of the first via.
- Every candidate is then verified through the set's own plan. The structure
  only says where to look. The plan decides who holds the set.
- There is no subject gate. An object in scope that the subject reaches through
  another arm is still returned.
- Several vias must form a chain of structural links, otherwise the result is
  empty. `null` and `undefined` entries are ignored, which makes an optional
  scope easy to pass.
- A via type that the compiled arms never connect to the listed type has an
  empty scope.

```ts
// documents ana can view, among those filed in one folder
await zbar
  .list()
  .object("document")
  .permission("view")
  .subject(ana)
  .via({ type: "folder", id: folderId })
  .collect(ctx);
```

### `listDirect()`

`listDirect()` returns **facts only**, never reach, together with their
properties. Use it for "who was granted what" screens and for reading edge
properties. Scope it by object, by subject or by both, given as a type or an
instance:

```ts
const rows = await zbar
  .listDirect()
  .object({ type: "alert", id: alertId })
  .relation("recipient")
  .collect(ctx);
// [{ subject: { type, id }, relation, object: { type, id }, properties }]
```

How filters behave:

- A `.relation(r)` or `.permission(p)` filter reads the writable relations in
  that set's inherits closure.
- A set with inverse arms has no facts of its own. Its members come back
  **flipped**: `subject` is the inverse node, `relation` is the set's name, and
  `object` is this object. Properties come from the underlying fact.

### Read limits

Each index range that a read issues returns at most **8,192** documents. A range
over more rows **throws** ("range over N rows; narrow the query") rather than
answer from a truncated result.

## Writes

All writes take a `MutationCtx` or an `ActionCtx`. Here `team`, `folder` and
`alert` are `{ type, id }` references like `ana` and `doc`.

```ts
await zbar.addRelation(ctx, ana, "owner", doc); // → fact id
await zbar.addRelation(ctx, team, "viewer", folder);
await zbar.addRelation(ctx, ana, "recipient", alert, {
  properties: { push: true },
});
// replaces every other relation ana holds on the team
await zbar.setRelation(ctx, ana, "admin", team);
await zbar.removeRelation(ctx, ana, "owner", doc); // → boolean
await zbar.deleteEntity(ctx, folder); // every fact touching the folder
```

The client validates every write against the schema. It checks that the relation
exists, that it is not a permission, that the subject type is allowed, and that
the properties match.

### What a write does

- **The fact and its mirror** are written in the caller's transaction. Computed
  arms read facts directly, so they reflect the write immediately.
- **Materialization** of any materialized arm that the fact feeds starts in the
  same transaction. It runs under `writeBudget` (default 1000 units). One unit
  is at most one index range, two document reads and two document writes. When
  the budget is spent, the unfinished work goes to the component's workpool as
  **one cursor**. That cursor's size is bounded by the schema, not by the data.
  It continues chunk by chunk, and the pool is serial (`maxParallelism: 1`).
  Materialized rows are eventually consistent. The invariant holds once the
  expansion has drained.
- **Removal is lineage-indexed.** Each derived path records the facts it came
  from. Removing a fact reads one index range (`lineage.by_fact`) and drops
  exactly the paths that name it, whatever config wrote them. No rules are
  re-evaluated.
- **`setRelation`** adds the new fact and removes the subject's other writable
  relations on the object, in one transaction. It runs the add work before the
  removal work. A row that both the old and the new fact derive gains its new
  path before it loses its old one, so readers never see such a row disappear.
- **`deleteEntity`** removes, by cursor, every fact where the entity is the
  subject or the object, each with the same lineage removal.

### Config changes and `rebuild`

The compiled schema and options form a config. The component stores the config
by content hash and keeps one **active** hash. The first write from a client
instance registers its config. After that, writes only ship the hash.

When a write changes the active hash, the same transaction enqueues `rebuild`.
This happens after a deploy that changed the schema, `writeBudget` or
`maxDepth`, and also after a rollback to an earlier schema. `rebuild` works by
cursor in two phases:

1. **derive**: ensures every fact's derived rows exist under the new config.
2. **retire**: drops every path the config no longer justifies. Before a row
   would lose its last path, `rebuild` re-derives a replacement from that path's
   own facts. A row the new config still derives therefore never disappears.

Queued work from an older config is dropped when it runs, and nothing is owed to
it. You can also call `rebuild` yourself. It is idempotent and resumable:

```ts
await zbar.rebuild(ctx);
```

### Failures

A chunk that throws is retried with half its budget, up to 5 attempts. After
that it is recorded in `expansionFailures`. Each failure has a `reason`:

| `reason`   | Meaning                                                             | Repair                  |
| ---------- | ------------------------------------------------------------------- | ----------------------- |
| `failed`   | a continuation chunk failed 5 times                                 | `resumeExpansion`       |
| `canceled` | a continuation was canceled                                         | `resumeExpansion`       |
| `depth`    | a derivation would exceed `maxDepth` facts                          | `rebuild` (after a fix) |
| `paths`    | a row already holds 32 current paths; the extra lineage was refused | `rebuild`               |

```ts
// newest first
const failures = await zbar.listExpansionFailures(ctx, { limit: 20 });
for (const f of failures.filter((f) => f.reason === "failed")) {
  await zbar.resumeExpansion(ctx, f._id); // re-enqueues the recorded cursor
}
```

### Options

```ts
createZbar(components.convzibar, {
  schema: zbarSchema,
  writeBudget: 1000, // budget units per transaction, then the workpool
  maxDepth: 16, // the most facts in one derivation, on reads and writes
});
```

Both options are compiled into the config and its hash. Changing either one
triggers an automatic `rebuild`.

The component also exposes generic, cursor-driven `maintenance` functions for
data migrations. `deleteFactsByRelation` removes facts by relation or entity
type through the normal lineage removal. `deleteEffectiveRowsByKeyPrefix`
removes derived rows that have no facts behind them. `pageFacts` pages through
facts. Call them through `components.convzibar.maintenance.*`.

## Testing

`convzibar/test` exports a
[`convex-test`](https://www.npmjs.com/package/convex-test) harness. It registers
the component together with its nested workpool. It uses `import.meta.glob`, so
run it under Vitest.

```ts
import { convexTest } from "convex-test";
import { registerZbarComponent } from "convzibar/test";
import { afterEach, beforeEach, test, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("ana can edit her document", async () => {
  const t = convexTest(schema, modules);
  registerZbarComponent(t); // mounts at "convzibar" (pass a name to override)
  // ... call your functions with t.mutation / t.query ...
  // drain materialization continuations queued in the workpool:
  await t.finishAllScheduledFunctions(vi.runAllTimers);
});
```

`zbarEngineTest()` returns a `convex-test` instance with the engine itself as
the root. Use it to call the component's functions directly through its
`_generated/api`.

## Upgrading from 2.x

3.0.0 redesigns the engine around the five-arm grammar. The removed forms and
their replacements:

| 2.x                                                                 | 3.0.0                                                                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `.readTimeRelation(name, path)`                                     | `.relation(name, path)`: computed is now the default                                                                             |
| `.relation(name, "parent.admin")` (materialized)                    | now computed; write `.relation(name, materialize("parent.admin"))` to keep write-time behaviour                                  |
| `{ type: "group", reverse: "device_member" }` on `device.container` | `device.container` takes `"group"`; declare an inverse on the far entity: `group.relation("device_member", "~device#container")` |
| `{ type: "user" }` arm objects                                      | the string `"user"`                                                                                                              |
| `.extend()`                                                         | removed; declare all of an entity's sets in its `.entity()` call                                                                 |
| `asyncWrites`, `maxWriteDepth`, `readTimeChainDepth`                | `writeBudget` (writes always continue in the workpool past the budget) and `maxDepth`                                            |
| `zbar.require(...)`                                                 | `if (!(await zbar.can(...))) throw ...`                                                                                          |
| `zbar.updateRelation(subject, old, new, object)`                    | `zbar.setRelation(subject, new, object)`                                                                                         |
| `convzibar/unsafe`                                                  | removed; use the component's `maintenance` functions and `rebuild`                                                               |
| `register(t)` from `convzibar/test`                                 | `registerZbarComponent(t)`; `register` stays as an alias                                                                         |

The compiler now rejects two forms when the schema loads. `T#permission` must
become a walk or target a relation. A materialized arm whose second hop contains
a computed arm must materialize that arm too, or stop being materialized.

An inverse arm reads the forward facts, so the facts that v2 inserted for
reverse edges are redundant. Delete them by paging
`components.convzibar.maintenance.deleteFactsByRelation` with
`{ relations: ["device_member", ...], cursor, numItems }` until `isDone`. The
same sweep tags every remaining fact's mirror in the 3.0 shape.

After upgrading, deploy. The first write under the new config hash enqueues a
`rebuild`, which re-derives every materialized row and retires the v2 rows the
new config does not justify. To do this without waiting for a write, call
`zbar.rebuild(ctx)` from a mutation once.

## License

Apache-2.0
