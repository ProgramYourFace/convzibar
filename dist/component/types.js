/**
 * The compiled graph configuration (v2).
 *
 * The schema builder (`lib/zbar/schema/builder.ts`) produces a `ZbarSchema`;
 * the compiler (`helpers.ts` `parseSchemaToGraphConfig`) turns it into this
 * `GraphConfig`. BOTH evaluators read only this object:
 *
 *   - the read-time planner (`lib/zbar/traversal.ts`) compiles `sets` into
 *     Traversal trees;
 *   - the write-time BFS (`expand.ts`, `mutations.ts`) applies `rules`.
 *
 * The contract both must implement is `CONTRACT.md` next to this file. In one
 * line: a materialized arm means exactly what the same arm means when computed.
 */
export {};
//# sourceMappingURL=types.js.map