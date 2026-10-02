import { writableSubjectTypes } from "../../component/helpers";
/**
 * Verify that a fact `(subject, relation, object)` may be written: the
 * relation exists and is writable (not a permission), and the subject's type
 * is a facts arm of the relation or of a relation it inherits (expansions
 * imply their type). Throws a descriptive error otherwise.
 */
export function validateRelationParameter(z, subject, relation, object) {
    const set = z.graphConfig.sets[object.type]?.[relation];
    if (!set) {
        throw new Error(`Zbar Schema Error: Relation '${relation}' is not defined for object type '${object.type}'.`);
    }
    if (!set.writable) {
        throw new Error(`Zbar Schema Error: '${relation}' on '${object.type}' is a permission; facts are written to relations only.`);
    }
    const validSubjectTypes = writableSubjectTypes(z.graphConfig, object.type, relation);
    if (validSubjectTypes.length === 0) {
        throw new Error(`Zbar Schema Error: Relation '${relation}' on '${object.type}' declares no direct typed subjects ` +
            `(it is derived through walks or inverses). Write the underlying fact instead.`);
    }
    if (!validSubjectTypes.includes(subject.type)) {
        throw new Error(`Zbar Schema Error: Subject type '${subject.type}' is not a valid subject for relation '${relation}' on object type '${object.type}'. Valid subject types: ${validSubjectTypes.join(", ")}.`);
    }
}
/**
 * Validate edge properties against the schema-defined validators.
 * Throws if required fields are missing or unknown fields are present.
 */
export function validateProperties(z, objectType, relation, properties) {
    const entityDef = z.schema.entities[objectType];
    const validators = entityDef?.propertyValidators?.[relation];
    if (!validators) {
        throw new Error(`Zbar Schema Error: No properties defined for relation '${relation}' on entity type '${objectType}'. ` +
            `Remove the 'properties' option or define properties with .properties('${relation}', { ... }) in the schema.`);
    }
    if (typeof properties !== "object" || properties === null) {
        throw new Error(`Zbar Schema Error: Properties for relation '${relation}' on '${objectType}' must be an object.`);
    }
    const props = properties;
    for (const [key, validator] of Object.entries(validators)) {
        const val = validator;
        if (val.isOptional !== "optional" && !(key in props)) {
            throw new Error(`Zbar Schema Error: Missing required property '${key}' for relation '${relation}' on '${objectType}'.`);
        }
    }
    for (const key of Object.keys(props)) {
        if (!(key in validators)) {
            throw new Error(`Zbar Schema Error: Unknown property '${key}' for relation '${relation}' on '${objectType}'. ` +
                `Defined properties: ${Object.keys(validators).join(", ")}.`);
        }
    }
}
//# sourceMappingURL=validation.js.map