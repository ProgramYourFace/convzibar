/**
 * Type-level checks of the schema builder and edge properties. Nothing here
 * runs: `tsc --noEmit` proves each line (every `@ts-expect-error` must be an
 * error), so this is a typecheck file, not a test file.
 */
import { v } from "convex/values";
import { createZbarSchema, materialize, Zbar } from "../index";

const schema = createZbarSchema()
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user")
      .properties("admin", {
        title: v.string(),
        level: v.number(),
        note: v.optional(v.string()),
      })
      .permission("manage", "admin"),
  )
  .build();

// The property validators are typed per relation.
void schema.entities.org.propertyValidators.admin.title;
void schema.entities.org.propertyValidators.admin.level;

export function addRelationShapes(z: Zbar<typeof schema>) {
  const u = { type: "user", id: "u1" } as const;
  const o = { type: "org", id: "o1" } as const;
  void z.addRelation({} as any, u, "owner", o, {
    // @ts-expect-error — "owner" has no properties, so `properties` is not allowed
    properties: { anything: true },
  });
  void z.addRelation({} as any, u, "owner", o); // no properties: fine
  void z.addRelation({} as any, u, "admin", o, {
    properties: { title: "CTO", level: 1 },
  });
  void z.addRelation({} as any, u, "admin", o, {
    properties: { title: "CTO", level: 1, note: "founder" },
  });
  void z.addRelation({} as any, u, "admin", o, {
    // @ts-expect-error — missing required field "level"
    properties: { title: "CTO" },
  });
  void z.addRelation({} as any, u, "admin", o, {
    // @ts-expect-error — wrong type for "level"
    properties: { title: "CTO", level: "high" },
  });
}

export function armForms() {
  createZbarSchema()
    // Facts arms may name an entity declared later in the chain.
    .entity("device", (e) =>
      e
        .relation("parent", "system")
        .relation(
          "admin",
          "system_user",
          "group#admin",
          materialize("parent.admin"),
        )
        .relation("viewer", "admin", "~device#parent")
        .permission("view", "viewer", "parent.view")
        // @ts-expect-error — 'veiwer' is neither a set on this entity nor a walk/expansion
        .permission("manage", "veiwer"),
    )
    .entity("system_user")
    .entity("group", (e) => e.relation("admin", "system_user"))
    .entity("system", (e) =>
      e.relation("viewer", "system_user").permission("view", "viewer"),
    );

  // @ts-expect-error — only a walk or an expansion can be materialized
  void materialize("admin");
}
