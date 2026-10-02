// Type-level arm shapes for the schema builder.
//
// Relation arms are plain strings at the type level: a facts arm may name an
// entity declared later in the chain (entities resolve at compile time, not
// in declaration order), so a template-literal union over the entities seen
// so far would reject valid schemas. The compiler checks every name when the
// schema is loaded. Permission arms never name an entity, so they keep a
// cheap typed union that catches a misspelt inherited set at compile time.
export {};
//# sourceMappingURL=builder-types.js.map