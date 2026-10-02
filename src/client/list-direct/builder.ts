import type { ActionCtx, QueryCtx } from "../internal";
import { BaseListBuilder } from "../list/base";
import {
  resolveFactRelations,
  resolveRelationInheritance,
} from "../zbar/resolvers";
import { readFactsForward, readFactsReverse } from "../zbar/traversal";
import type { DirectRelationship } from "./types";

/**
 * Internal implementation of the fluent direct-relationship query builder.
 *
 * `listDirect()` returns FACTS, never reach (CONTRACT §3). A `.relation(r)` or
 * `.permission(p)` filter reads the writable members of the set's inherits
 * closure (`factRelations`). A set with inverse arms (`~T#r`) has no facts of
 * its own; its members are facts `(o, r, x)` read backwards, so they are
 * returned flipped: `{ subject: x, relation: <the set>, object: o }`, with the
 * underlying fact's properties.
 */
export class ListDirectQueryBuilder extends BaseListBuilder<DirectRelationship> {
  async collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]> {
    const z = this.z;
    const config = z.graphConfig;
    const objectType = this._objectType;
    const setName = this._relation ?? this._permission;

    const subject =
      this._subjectType && this._subjectId
        ? { type: this._subjectType, id: this._subjectId }
        : undefined;
    const object =
      objectType && this._objectId
        ? { type: objectType, id: this._objectId }
        : undefined;

    // No set named: every fact at the anchor(s).
    if (!setName || !objectType) {
      const rows: any[] = await ctx.runQuery(
        z.component.queries.listDirectRelationships,
        {
          subject,
          object,
          filterSubjectType:
            this._subjectType && !this._subjectId
              ? this._subjectType
              : undefined,
          filterObjectType:
            objectType && !this._objectId ? objectType : undefined,
        },
      );
      return this._applyMap(rows.map(toDirect));
    }

    const closure = resolveRelationInheritance(z, objectType, setName);
    const factRelations = resolveFactRelations(z, objectType, setName);
    const reads: Promise<DirectRelationship[]>[] = [];

    if (factRelations.length > 0) {
      reads.push(
        ctx
          .runQuery(z.component.queries.listDirectRelationships, {
            subject,
            object,
            relations: factRelations,
            filterSubjectType:
              this._subjectType && !this._subjectId
                ? this._subjectType
                : undefined,
            filterObjectType: !this._objectId ? objectType : undefined,
          })
          .then((rows: any[]) => rows.map(toDirect)),
      );
    }

    // Inverse arms: one facts range per arm, anchored on whichever end is pinned.
    for (const member of closure) {
      for (const arm of config.sets[objectType]?.[member]?.arms ?? []) {
        if (arm.kind !== "inverse") continue;
        if (this._subjectType && this._subjectType !== arm.subjectType)
          continue;
        const flip = (
          o: string,
          x: string,
          properties: unknown,
        ): DirectRelationship => ({
          subject: { type: arm.subjectType, id: x },
          relation: member,
          object: { type: objectType, id: o },
          properties,
        });
        if (object) {
          reads.push(
            readFactsForward(z, ctx, [object], [arm.relation], {
              type: arm.subjectType,
              ids: subject ? [subject.id] : undefined,
            }).then((rows) =>
              rows.map((r) => flip(r.subjectId, r.objectId, r.properties)),
            ),
          );
        } else if (subject) {
          reads.push(
            readFactsReverse(z, ctx, [subject], [arm.relation], {
              type: objectType,
            }).then((rows) =>
              rows.map((r) => flip(r.subjectId, r.objectId, r.properties)),
            ),
          );
        }
      }
    }

    return this._applyMap((await Promise.all(reads)).flat());
  }
}

function toDirect(r: any): DirectRelationship {
  return {
    subject: { type: r.subjectType, id: r.subjectId },
    relation: r.relation,
    object: { type: r.objectType, id: r.objectId },
    properties: r.properties,
  };
}
