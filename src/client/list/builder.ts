import type { ActionCtx, QueryCtx } from "../internal";
import {
  collectViaObjects,
  collectViaSubjects,
  planSet,
} from "../zbar/traversal";
import { BaseListBuilder } from "./base";

type ListResult = { objectId: string } | { subjectId: string };

/**
 * Internal implementation of the fluent list query builder. A single class
 * implements all builder interfaces; the TypeScript interfaces (in ./types.ts)
 * restrict which methods are visible at each step.
 *
 * A relation and a permission compile the same way (`planSet`): both are sets
 * of arms, the permission merely unwritable.
 */
export class ListQueryBuilder extends BaseListBuilder<ListResult> {
  private _via: { type: string; id: string }[] = [];
  private _mode!: "listObjects" | "listSubjects";

  override object(objectOrType: string | { type: string; id: string }): this {
    super.object(objectOrType);
    this._mode =
      typeof objectOrType === "string" ? "listObjects" : "listSubjects";
    return this;
  }

  via(...entities: ({ type: string; id: string } | null | undefined)[]): this {
    this._via = entities.filter(
      (e): e is { type: string; id: string } =>
        e != null && typeof e.type === "string" && typeof e.id === "string",
    );
    return this;
  }

  async collect(ctx: QueryCtx | ActionCtx): Promise<ListResult[]> {
    const z = this.z;
    const objectType = this._objectType!;
    const plan = planSet(z, objectType, (this._relation ?? this._permission)!);
    const hasVia = this._via.length > 0;

    if (this._mode === "listObjects") {
      const subject = { type: this._subjectType!, id: this._subjectId! };
      const ids = hasVia
        ? await collectViaObjects(z, ctx, plan, subject, this._via, objectType)
        : await plan.expandObjects(ctx, subject, objectType);
      return this._applyMap([...ids].map((id) => ({ objectId: id })));
    }

    const object = { type: objectType, id: this._objectId! };
    const subjectType = this._subjectType!;
    const ids = hasVia
      ? await collectViaSubjects(z, ctx, plan, object, this._via, subjectType)
      : await plan.expandSubjects(ctx, object, subjectType);
    return this._applyMap([...ids].map((id) => ({ subjectId: id })));
  }
}
