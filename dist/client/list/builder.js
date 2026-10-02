import { collectViaObjects, collectViaSubjects, planSet, } from "../zbar/traversal";
import { BaseListBuilder } from "./base";
/**
 * Internal implementation of the fluent list query builder. A single class
 * implements all builder interfaces; the TypeScript interfaces (in ./types.ts)
 * restrict which methods are visible at each step.
 *
 * A relation and a permission compile the same way (`planSet`): both are sets
 * of arms, the permission merely unwritable.
 */
export class ListQueryBuilder extends BaseListBuilder {
    _via = [];
    _mode;
    object(objectOrType) {
        super.object(objectOrType);
        this._mode =
            typeof objectOrType === "string" ? "listObjects" : "listSubjects";
        return this;
    }
    via(...entities) {
        this._via = entities.filter((e) => e != null && typeof e.type === "string" && typeof e.id === "string");
        return this;
    }
    async collect(ctx) {
        const z = this.z;
        const objectType = this._objectType;
        const plan = planSet(z, objectType, (this._relation ?? this._permission));
        const hasVia = this._via.length > 0;
        if (this._mode === "listObjects") {
            const subject = { type: this._subjectType, id: this._subjectId };
            const ids = hasVia
                ? await collectViaObjects(z, ctx, plan, subject, this._via, objectType)
                : await plan.expandObjects(ctx, subject, objectType);
            return this._applyMap([...ids].map((id) => ({ objectId: id })));
        }
        const object = { type: objectType, id: this._objectId };
        const subjectType = this._subjectType;
        const ids = hasVia
            ? await collectViaSubjects(z, ctx, plan, object, this._via, subjectType)
            : await plan.expandSubjects(ctx, object, subjectType);
        return this._applyMap([...ids].map((id) => ({ subjectId: id })));
    }
}
//# sourceMappingURL=builder.js.map