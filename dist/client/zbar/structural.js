/**
 * Structure for `.via()`, derived from the compiled arms (CONTRACT §4.9).
 *
 * Two nodes are structurally linked when a FACT connects them on a relation
 * the schema declares between their types. `admittedRelations(O, S)` is the
 * set of relations on `O` whose facts may have a subject of type `S`:
 *
 *   • a facts arm `S` or an expands arm `S#t` on the relation (expands imply
 *     their type as a writable fact type);
 *   • the via relation of a walks arm on `O` whose via type is `S`;
 *   • the relation named by an inverse arm `~O#r` on `S` (its facts are
 *     `(s, r, o)`), so an inverse declared only on the far side still links.
 *
 * Facts, not derived rows: the scope is "where to look", read in one range
 * per relation; whether the subject holds the set is decided by the plan.
 */
function admittedRelations(config, objectType, subjectType) {
    const out = new Set();
    for (const set of Object.values(config.sets[objectType] ?? {})) {
        for (const arm of set.arms) {
            if (set.writable &&
                (arm.kind === "facts" || arm.kind === "expands") &&
                arm.subjectType === subjectType) {
                out.add(set.name);
            }
            else if (arm.kind === "walks" && arm.viaType === subjectType) {
                out.add(arm.viaRelation);
            }
        }
    }
    for (const set of Object.values(config.sets[subjectType] ?? {})) {
        for (const arm of set.arms) {
            if (arm.kind === "inverse" && arm.subjectType === objectType)
                out.add(arm.relation);
        }
    }
    return [...out];
}
/**
 * The relations linking a node of `viaType` to nodes of `otherType`, by the
 * fact's direction: `outgoing` facts are `(via, r, other)` (r on `otherType`),
 * `incoming` facts are `(other, r, via)` (r on `viaType`).
 */
export function structuralRelations(config, viaType, otherType) {
    return {
        outgoing: admittedRelations(config, otherType, viaType),
        incoming: admittedRelations(config, viaType, otherType),
    };
}
//# sourceMappingURL=structural.js.map