/**
 * The `${type}:${id}` scope-key convention of `effectiveRelationships.subjectKey`
 * / `objectKey`, and the one encoding of a key-prefix range. One module, one
 * implementation, so neither can drift between the writer and the readers.
 */
export function buildScopeKey(type, id) {
    return `${type}:${id}`;
}
/**
 * Decode `${type}:${id}` preserving any colons in `id`. The naive
 * `split(":")` truncates ids that themselves contain a colon, silently
 * matching the wrong row.
 */
export function decodeScopeKey(scopeKey) {
    const idx = scopeKey.indexOf(":");
    return [scopeKey.slice(0, idx), scopeKey.slice(idx + 1)];
}
/**
 * The half-open range `[lower, upper)` of every string that starts with
 * `prefix`: `upper` is `prefix` with its last code unit incremented, the
 * smallest string greater than every extension of `prefix`. No sentinel
 * character, so no id is ever outside the range.
 */
export function prefixRange(prefix) {
    if (prefix.length === 0)
        throw new Error("convzibar: an empty prefix has no range");
    const last = prefix.charCodeAt(prefix.length - 1);
    return {
        lower: prefix,
        upper: prefix.slice(0, -1) + String.fromCharCode(last + 1),
    };
}
/** Every scope key of one entity type: `prefixRange('type:')`. */
export function typeRange(type) {
    return prefixRange(`${type}:`);
}
//# sourceMappingURL=keys.js.map