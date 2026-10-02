import type { GraphConfig } from "../../component/types";
/**
 * The relations linking a node of `viaType` to nodes of `otherType`, by the
 * fact's direction: `outgoing` facts are `(via, r, other)` (r on `otherType`),
 * `incoming` facts are `(other, r, via)` (r on `viaType`).
 */
export declare function structuralRelations(config: GraphConfig, viaType: string, otherType: string): {
    outgoing: string[];
    incoming: string[];
};
//# sourceMappingURL=structural.d.ts.map