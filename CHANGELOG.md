# Changelog

## 3.0.0

Schema v2: one arm grammar, computed by default, and a materialization path with
proofs. The engine (`src/component`) and client (`src/client`) are the versions
that shipped inside the AllAware app on 2026-10-01; its parity, engine, race,
consistency and scale suites come with them.

### Breaking

- **One arm grammar.** A set (relation or permission) is the union of its arms:
  facts `"user"`, inherits `"admin"`, expands `"group#viewer"`, walks
  `"parent.admin"`, inverse `"~device#parent"`. Every walks/expands arm is
  **computed at read time by default**; wrap it in `materialize(...)` to keep
  write-time rows. `.readTimeRelation()`, `.extend()` and the
  `{ type, reverse }` reverse-edge form are removed (the inverse arm replaces
  the latter, declared on the far entity).
- **Typed intermediates.** `group#viewer` expands only through subjects of type
  `group`; `parent.admin` walks only through the types the `parent` relation
  admits. Names never resolve across types.
- **First hop reads facts, second hop reads the full set.** Derived rows are
  never a first hop; `#` may not target a permission.
- **Client options.** `asyncWrites`, `maxWriteDepth` and `readTimeChainDepth`
  are gone. `writeBudget` (default 1000 fetch-charged units per transaction) and
  `maxDepth` (default 16 facts per derivation, both sides) replace them; both
  are compiled into the config hash.
- **`convzibar/unsafe` removed.** `rebuild()` re-derives and retires rows under
  the active config; the component's `maintenance` functions delete by relation
  or key prefix.
- **Component schema.** `effectiveRelationships.paths[].rule` keys rules by
  content and upstream; new tables `lineage`, `expansionFailures`,
  `activeConfig`, `mockWorkpool` (test driver); the transitional v1 fields and
  `auditLog` table are gone. Deploying over 2.x data: the first write under the
  new config hash enqueues an automatic `rebuild`.
- **Peer dependency** `convex` ^1.45; depends on `@convex-dev/workpool` ^0.4.11
  and `convex-helpers`.

### Added

- **The invariant (CONTRACT §4): materialization never changes an answer.**
  `can`, `hasRelationship`, `getPermissions`, `list()` both ways, `.via()` and
  `listDirect()` return the same result whether an arm is computed or
  materialized. `src/client/tests/parity.test.ts` runs every read over every
  fixture under both modes against an independent oracle.
- **Lineage-indexed removal.** Every derived row records the facts it depends on
  (`lineage{factId,rowId,path}`); removing a fact deletes exactly its dependents
  in one index range per fact, under any config history (EXPANSION.md invariants
  W and L).
- **One continuation per transaction.** A write materializes under
  `writeBudget`, then hands one schema-bounded cursor to the component's serial
  workpool (`maxParallelism: 1`); a failed chunk retries with half its budget.
  Lemma B / P1–P7 in EXPANSION.md.
- **Active config + auto-rebuild.** Activating a different config hash
  (including a rollback) enqueues `rebuild`: derive under the new rules, then
  retire paths the new rules do not justify. Stale-config cursors are dropped.
- **Bounded everything.** `maxDepth` checked statically for acyclic chains and
  at runtime for recursive ones (reads throw rather than truncate; writes record
  `expansionFailures{reason:"depth"}`); a 32-path cap per row
  (`reason:"paths"`); every read range capped at 8,192 rows.
- `zbar.rebuild(ctx)`, `zbar.listExpansionFailures(ctx)`,
  `zbar.resumeExpansion(ctx, failureId)`.
- `.via(...)` is defined: exactly the full list intersected with the structural
  scope of the pinned entities, chains allowed, no subject gate.
- `listDirect()` returns facts of a set's writable closure; a set with inverse
  arms returns its facts flipped.
- `convzibar/test` exports `zbarEngineTest()` and `registerZbarComponent()`
  (which also registers the nested workpool); `register` stays as an alias.
- `src/component/CONTRACT.md` (definition) and `src/component/EXPANSION.md`
  (proofs) are the specification.

## 2.0.0

Simplification release: the engine is now ReBAC-only, single-tenant, and ~30%
smaller. No behavior changes to retained functionality.

### Breaking

- **ABAC conditions removed.** `.condition()`, `{ relation, condition }`
  targets, the `condition`/`conditionContext` write options, and the
  `requestContext` parameter on every read (`can`, `hasRelationship`,
  `getPermissions`, `require`, `.collect()`) are gone. `createZbarSchema()` and
  `createZbar()` lose their `Data`/context generics.
- **Multi-tenancy removed.** The required `tenantId` client option and
  `.withTenant()` are gone; tables are no longer tenant-indexed.
- **Audit log removed.** `enableAuditLog`, `defaultActorId`, and the
  `createdBy`/`actorId` write options are gone.
- **Component query surface consolidated.** The seven per-shape queries
  (`checkPermissionFast`, `checkPermissionBatch*`, `list*Fast`, `list*Batch`)
  collapse into `effectiveForward` / `effectiveReverse` with identical dispatch
  semantics.

### Changed

- Mutations ship a stable content hash of the compiled graph config instead of
  the full rule set; the component stores configs in a new `configs` table
  (registered automatically on first write, self-healing if the registration is
  lost).
- `getPermissions()` runs at most one shared read-time branch per unique derived
  relation (previously one per pending permission).

### Upgrade notes

- The v2 component schema still declares the legacy v1 fields (`tenantId`,
  `condition`, `conditionContext`, per-path `conditions`) as optional and keeps
  the `auditLog` table, so an in-place `convex deploy` over v1 data passes
  schema validation. The engine never reads or writes them; the transitional
  declarations can be deleted after data cleanup.

## 0.0.0

- Initial release.
