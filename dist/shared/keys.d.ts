/**
 * The `${type}:${id}` scope-key convention of `effectiveRelationships.subjectKey`
 * / `objectKey`, and the one encoding of a key-prefix range. One module, one
 * implementation, so neither can drift between the writer and the readers.
 */
export declare function buildScopeKey(type: string, id: string): string;
/**
 * Decode `${type}:${id}` preserving any colons in `id`. The naive
 * `split(":")` truncates ids that themselves contain a colon, silently
 * matching the wrong row.
 */
export declare function decodeScopeKey(scopeKey: string): [type: string, id: string];
/**
 * The half-open range `[lower, upper)` of every string that starts with
 * `prefix`: `upper` is `prefix` with its last code unit incremented, the
 * smallest string greater than every extension of `prefix`. No sentinel
 * character, so no id is ever outside the range.
 */
export declare function prefixRange(prefix: string): {
    lower: string;
    upper: string;
};
/** Every scope key of one entity type: `prefixRange('type:')`. */
export declare function typeRange(type: string): {
    lower: string;
    upper: string;
};
//# sourceMappingURL=keys.d.ts.map