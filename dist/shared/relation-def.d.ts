/**
 * Arm parsing for the compiler (`helpers.ts`).
 *
 * The schema stores arms verbatim (strings and `materialize()` wrappers).
 * Classifying them in one place keeps the grammar of CONTRACT.md §2 in one
 * place: syntax decides walks / expands / inverse; a bare name is resolved
 * against the entity's sets first and the entity types second.
 */
type RelationTargetShape = 
/** A bare name that is a set (relation or permission) on the same entity. */
{
    kind: "inherits";
    set: string;
    raw: string;
    materialized: boolean;
}
/** A bare name that is an entity type. */
 | {
    kind: "facts";
    subjectType: string;
    raw: string;
    materialized: boolean;
}
/** `'type#set'`. */
 | {
    kind: "expands";
    subjectType: string;
    targetSet: string;
    raw: string;
    materialized: boolean;
}
/** `'via.set'`. */
 | {
    kind: "walks";
    viaRelation: string;
    targetSet: string;
    raw: string;
    materialized: boolean;
}
/** `'~type#relation'`. */
 | {
    kind: "inverse";
    subjectType: string;
    relation: string;
    raw: string;
    materialized: boolean;
}
/** A bare name that is neither a set here nor an entity type. */
 | {
    kind: "unknown";
    raw: string;
    materialized: boolean;
}
/** Not one of the five forms (two operators, empty segments, three segments...). */
 | {
    kind: "invalid";
    raw: string;
    materialized: boolean;
    reason: string;
};
interface ClassificationContext {
    /** Every set (relation AND permission) declared on the entity that owns the arm, but the set itself. */
    localSets: ReadonlySet<string>;
    /** All declared entity types. */
    entities: ReadonlySet<string>;
}
/**
 * Classify every arm of one set (`undefined`: a set with no arms). Anything
 * that is neither a string nor `{ materialize: string }` is invalid.
 */
export declare function iterateRelationTargets(arms: unknown, ctx: ClassificationContext): Generator<RelationTargetShape>;
export {};
//# sourceMappingURL=relation-def.d.ts.map