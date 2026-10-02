/** Rows `(subject, relation ∈ relations, object)`; the object side is points (scope keys) or a type range. */
export declare const effectiveForward: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
/** Rows `(subject, relation ∈ relations, object)`; the subject side is points (scope keys) or a type range. */
export declare const effectiveReverse: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
/** Facts `(subject ∈ subjects, relation ∈ relations, object)`, object side as points or a type range. */
export declare const factsForward: import("convex/server").RegisteredQuery<"public", any, Promise<{
    subjectType: string;
    subjectId: string;
    relation: string;
    objectType: string;
    objectId: string;
    properties: any;
}[]>>;
/** Facts `(subject, relation ∈ relations, object ∈ objects)`, subject side as points or a type range. */
export declare const factsReverse: import("convex/server").RegisteredQuery<"public", any, Promise<{
    subjectType: string;
    subjectId: string;
    relation: string;
    objectType: string;
    objectId: string;
    properties: any;
}[]>>;
/**
 * Facts with their properties, for `listDirect()`. Anchored on the subject, the
 * object, or both. With a relation list every read is one exact range per
 * relation (the far-side type joins the prefix when given); without one the
 * anchor's whole prefix is read and type filters apply in memory.
 */
export declare const listDirectRelationships: import("convex/server").RegisteredQuery<"public", any, Promise<{
    subjectType: string;
    subjectId: string;
    relation: string;
    objectType: string;
    objectId: string;
    properties: any;
    _id: any;
    _creationTime: any;
}[]>>;
/** The most recent expansion failures, newest first. Bounded by `limit` (default 100). */
export declare const listExpansionFailures: import("convex/server").RegisteredQuery<"public", any, Promise<any>>;
//# sourceMappingURL=queries.d.ts.map