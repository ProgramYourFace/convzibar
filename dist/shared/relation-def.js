/**
 * Arm parsing for the compiler (`helpers.ts`).
 *
 * The schema stores arms verbatim (strings and `materialize()` wrappers).
 * Classifying them in one place keeps the grammar of CONTRACT.md §2 in one
 * place: syntax decides walks / expands / inverse; a bare name is resolved
 * against the entity's sets first and the entity types second.
 */
/** Split `a<sep>b` into exactly two non-empty segments, or undefined. */
function pair(raw, sep) {
    const parts = raw.split(sep);
    return parts.length === 2 && parts[0] && parts[1]
        ? [parts[0], parts[1]]
        : undefined;
}
/**
 * Classify one arm. Syntax first (exactly one of `~…#`, `#`, `.`), then a
 * bare name resolves to a local set before an entity type, so a schema can
 * always say "inherit `admin`" even if an entity were also called `admin`.
 */
function classifyStringRef(arm, ctx) {
    const materialized = typeof arm === "object";
    const raw = typeof arm === "object" ? arm.materialize : arm;
    const invalid = (reason) => ({
        kind: "invalid",
        raw,
        materialized,
        reason,
    });
    const hasHash = raw.includes("#");
    const hasDot = raw.includes(".");
    const hasTilde = raw.includes("~");
    if ((hasHash && hasDot) || (hasTilde && (!raw.startsWith("~") || !hasHash))) {
        return invalid("an arm uses exactly one of '#', '.' or a leading '~#'");
    }
    if (hasTilde) {
        const p = pair(raw.slice(1), "#");
        if (!p || raw.slice(1).includes("~"))
            return invalid("an inverse is written '~type#relation'");
        return {
            kind: "inverse",
            subjectType: p[0],
            relation: p[1],
            raw,
            materialized,
        };
    }
    if (hasHash) {
        const p = pair(raw, "#");
        if (!p)
            return invalid("an expansion is written 'type#relation'");
        return {
            kind: "expands",
            subjectType: p[0],
            targetSet: p[1],
            raw,
            materialized,
        };
    }
    if (hasDot) {
        const p = pair(raw, ".");
        if (!p)
            return invalid("a walk must have exactly two segments ('relation.set')");
        return {
            kind: "walks",
            viaRelation: p[0],
            targetSet: p[1],
            raw,
            materialized,
        };
    }
    if (ctx.localSets.has(raw))
        return { kind: "inherits", set: raw, raw, materialized };
    if (ctx.entities.has(raw))
        return { kind: "facts", subjectType: raw, raw, materialized };
    return { kind: "unknown", raw, materialized };
}
/**
 * Classify every arm of one set (`undefined`: a set with no arms). Anything
 * that is neither a string nor `{ materialize: string }` is invalid.
 */
export function* iterateRelationTargets(arms, ctx) {
    if (arms === undefined || arms === null)
        return;
    for (const d of Array.isArray(arms) ? arms : [arms]) {
        if (typeof d === "string") {
            yield classifyStringRef(d, ctx);
        }
        else if (d &&
            typeof d === "object" &&
            typeof d.materialize === "string") {
            yield classifyStringRef(d, ctx);
        }
        else {
            yield {
                kind: "invalid",
                raw: JSON.stringify(d),
                materialized: false,
                reason: "not an arm",
            };
        }
    }
}
//# sourceMappingURL=relation-def.js.map