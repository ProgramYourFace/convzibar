import type { GraphConfig } from "./types";
/** FNV-1a (32-bit) of a string with the given offset basis, as 8 hex digits. */
export declare function fnv1a(s: string, seed?: number): string;
export declare function parseSchemaToGraphConfig(schema: any, options?: {
    maxDepth?: number;
    writeBudget?: number;
}): GraphConfig;
/**
 * The subject types a fact written to `(objectType, relation)` may have:
 * the facts arms (declared, or implied by an expansion) of the relation and
 * of every relation it inherits. Empty for a permission or an unknown set.
 */
export declare function writableSubjectTypes(config: GraphConfig, objectType: string, relation: string): string[];
//# sourceMappingURL=helpers.d.ts.map