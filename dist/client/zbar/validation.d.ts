import type { ZbarInternal } from "../internal";
/**
 * Verify that a fact `(subject, relation, object)` may be written: the
 * relation exists and is writable (not a permission), and the subject's type
 * is a facts arm of the relation or of a relation it inherits (expansions
 * imply their type). Throws a descriptive error otherwise.
 */
export declare function validateRelationParameter(z: ZbarInternal, subject: {
    type: string;
}, relation: string, object: {
    type: string;
}): void;
/**
 * Validate edge properties against the schema-defined validators.
 * Throws if required fields are missing or unknown fields are present.
 */
export declare function validateProperties(z: ZbarInternal, objectType: string, relation: string, properties: unknown): void;
//# sourceMappingURL=validation.d.ts.map