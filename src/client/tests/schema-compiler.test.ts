// Invariants of the schema compiler (`parseSchemaToGraphConfig`), stated as
// exact equalities on its output. CONTRACT.md (convex/components/convzibar)
// is the specification; each block names the clause it checks. The app
// schema is the real one (`schemas/zbar.ts`).

import { describe, expect, test } from "vitest";
import { createZbarSchema, materialize } from "../index";
import {
  parseSchemaToGraphConfig,
  writableSubjectTypes,
} from "../../component/helpers";
import type { CompiledSet, GraphConfig } from "../../component/types";
import { schema as appSchema } from "./fixtures/aa-app-schema";
import { validateRelationParameter } from "../zbar/validation";
import { appSchemaDesc } from "./fixtures/appSchema";
import { deriveSchemas } from "./fixtures/derive";

/** `key` is `base@fingerprint`; the base names the rule's own content (CONTRACT §5.1). */
const baseOf = (key: string) => {
  expect(key).toMatch(/@[0-9a-f]{8}$/);
  return key.slice(0, key.lastIndexOf("@"));
};
const withBase = (config: GraphConfig) =>
  config.rules.map(({ key, ...rule }) => ({ base: baseOf(key), ...rule }));

describe("the app schema (schemas/zbar.ts)", () => {
  const config = parseSchemaToGraphConfig(appSchema);

  test("rules: exactly the two materialized `source` expansions (CONTRACT §5.1)", () => {
    expect(withBase(config)).toEqual([
      {
        base: "notification_rule.source<=source:group#devices(devices;device#admin,device#operator,device#viewer)",
        objectType: "notification_rule",
        derived: "source",
        firstHop: { relation: "source", intermediateType: "group" },
        secondHop: {
          relations: ["devices"],
          inverses: [
            { subjectType: "device", relation: "admin" },
            { subjectType: "device", relation: "operator" },
            { subjectType: "device", relation: "viewer" },
          ],
        },
      },
      {
        base: "notification_rule.source<=source:system#devices(devices;device#parent)",
        objectType: "notification_rule",
        derived: "source",
        firstHop: { relation: "source", intermediateType: "system" },
        secondHop: {
          relations: ["devices"],
          inverses: [{ subjectType: "device", relation: "parent" }],
        },
      },
    ]);
  });

  test("defaults are present, and every set has a finite lineage bound (no recursion)", () => {
    expect(config).toMatchObject({
      version: 2,
      maxDepth: 16,
      writeBudget: 1000,
    });
    const sets = Object.values(config.sets).flatMap((byName) =>
      Object.values(byName),
    );
    expect(sets.filter((s) => s.maxLineage === null)).toEqual([]);
  });

  test("the parity fixture describes this schema: its compiled sets equal these, materialize flags aside", () => {
    const computed = (c: GraphConfig) =>
      Object.fromEntries(
        Object.entries(c.sets).map(([type, byName]) => [
          type,
          Object.fromEntries(
            Object.entries(byName).map(([name, set]): [string, CompiledSet] => [
              name,
              {
                ...set,
                arms: set.arms.map((a) =>
                  "materialized" in a ? { ...a, materialized: false } : a,
                ),
              },
            ]),
          ),
        ]),
      );
    const fixture = parseSchemaToGraphConfig(
      deriveSchemas(appSchemaDesc).computed,
    );
    expect(computed(fixture)).toEqual(computed(config));
  });

  test("writable subject types: facts arms of the relation and of the relations it inherits", () => {
    expect(writableSubjectTypes(config, "device", "viewer")).toEqual([
      "system_user",
      "group",
    ]);
    expect(writableSubjectTypes(config, "system_user", "viewer")).toEqual([
      "system_user",
      "group",
    ]);
    expect(writableSubjectTypes(config, "system", "devices")).toEqual([]); // inverse-only: never written
    expect(writableSubjectTypes(config, "device", "view")).toEqual([]); // a permission
  });
});

test("a fact may be written only to a relation, with a subject type that relation (or one it inherits) accepts", () => {
  const z = { graphConfig: parseSchemaToGraphConfig(appSchema) } as any;
  const write = (subject: string, relation: string, object: string) => () =>
    validateRelationParameter(z, { type: subject }, relation, { type: object });

  expect(write("group", "operator", "device")).not.toThrow(); // implied by 'group#viewer'
  expect(write("group", "viewer", "device")).not.toThrow();
  expect(write("system_user", "self", "system_user")).not.toThrow();
  expect(write("system", "viewer", "device")).toThrow(
    "Subject type 'system' is not a valid subject for relation 'viewer' on object type 'device'. Valid subject types: system_user, group.",
  );
  expect(write("system_user", "nope", "device")).toThrow(
    "Relation 'nope' is not defined for object type 'device'.",
  );
  expect(write("system_user", "view", "device")).toThrow(
    "'view' on 'device' is a permission; facts are written to relations only.",
  );
  expect(write("device", "devices", "system")).toThrow(
    "Relation 'devices' on 'system' declares no direct typed subjects",
  );
});

// ---------------------------------------------------------------------------
// CONTRACT §2.1 / §5.1: a materialized arm's first hop reads every writable
// relation in the closure that can hold a fact of the intermediate type; its
// second hop is the target's writable closure plus the closure's inverses.
// ---------------------------------------------------------------------------

test("materialized first hop spans the inherited fact relations; second hop spans the target closure", () => {
  const config = parseSchemaToGraphConfig(
    createZbarSchema()
      .entity("system_user")
      .entity("system", (e) =>
        e
          .relation("owner", "system_user")
          .relation("admin", "owner", "system_user")
          .relation("devices", "~device#parent"),
      )
      .entity("group", (e) =>
        e
          .relation("admin", "system_user")
          .relation("viewer", "admin", "system_user"),
      )
      .entity("device", (e) =>
        e
          .relation("parent", "system")
          .relation(
            "admin",
            "system_user",
            "group#admin",
            materialize("parent.admin"),
          )
          .relation(
            "operator",
            "admin",
            "system_user",
            materialize("group#viewer"),
          ),
      )
      .build(),
  );
  expect(withBase(config)).toEqual([
    {
      base: "device.admin<=parent:system#admin(admin,owner;)",
      objectType: "device",
      derived: "admin",
      firstHop: { relation: "parent", intermediateType: "system" },
      secondHop: { relations: ["admin", "owner"], inverses: [] },
    },
    {
      base: "device.operator<=admin:group#viewer(viewer,admin;)",
      objectType: "device",
      derived: "operator",
      firstHop: { relation: "admin", intermediateType: "group" },
      secondHop: { relations: ["viewer", "admin"], inverses: [] },
    },
    {
      base: "device.operator<=operator:group#viewer(viewer,admin;)",
      objectType: "device",
      derived: "operator",
      firstHop: { relation: "operator", intermediateType: "group" },
      secondHop: { relations: ["viewer", "admin"], inverses: [] },
    },
  ]);
});

// ---------------------------------------------------------------------------
// Every schema error fires with a precise message.
// ---------------------------------------------------------------------------

type RawSchema = Parameters<typeof parseSchemaToGraphConfig>[0];
const base = {
  user: { relations: {} },
  system: {
    relations: { admin: ["user"], viewer: ["admin", "user"] },
    permissions: { view: ["viewer"] },
  },
};
const withDevice = (device: {
  relations?: object;
  permissions?: object;
}): RawSchema => ({
  entities: { ...base, device: { relations: {}, permissions: {}, ...device } },
});

describe("schema errors", () => {
  test.each<[string, RawSchema, string | RegExp]>([
    [
      "a bare name that is neither a set nor an entity (typo guard)",
      withDevice({ relations: { admin: ["user"], viewer: ["admni"] } }),
      "Zbar Schema Error: relation 'viewer' on 'device' references 'admni', which is neither a relation or permission declared on 'device' nor a known entity type. Use a declared set [admin], an entity type [user, system, device], a walk ('relation.set'), an expansion ('type#relation') or an inverse ('~type#relation').",
    ],
    [
      "two operators in one arm",
      withDevice({
        relations: { parent: ["system"], viewer: ["parent.viewer#x"] },
      }),
      "Zbar Schema Error: relation 'viewer' on 'device' has arm 'parent.viewer#x': an arm uses exactly one of '#', '.' or a leading '~#'.",
    ],
    [
      "a walk with three segments",
      withDevice({
        relations: { parent: ["system"], viewer: ["parent.admin.user"] },
      }),
      "Zbar Schema Error: relation 'viewer' on 'device' has arm 'parent.admin.user': a walk must have exactly two segments ('relation.set').",
    ],
    [
      "an expansion that targets a permission",
      withDevice({ relations: { viewer: ["system#view"] } }),
      "Zbar Schema Error: relation 'viewer' on 'device' has arm 'system#view', but 'view' is a permission on 'system'; # may target relations only; use a walk or inherit a relation.",
    ],
    [
      "an expansion of an unknown type",
      withDevice({ relations: { viewer: ["sytem#viewer"] } }),
      "Zbar Schema Error: relation 'viewer' on 'device' has arm 'sytem#viewer', but 'sytem' is not an entity. Known entities: [user, system, device].",
    ],
    [
      "an expansion of an unknown set",
      withDevice({ relations: { viewer: ["system#nope"] } }),
      "Zbar Schema Error: relation 'viewer' on 'device' has arm 'system#nope', but 'system' declares no set 'nope'. Its sets: [admin, viewer, view].",
    ],
    [
      "an inverse of a relation that does not accept this type",
      withDevice({ relations: { admins: ["~system#admin"] } }),
      "Zbar Schema Error: relation 'admins' on 'device' has arm '~system#admin', but 'system.admin' does not accept 'device' as a fact subject; it accepts [user].",
    ],
    [
      "an inverse of a permission",
      withDevice({ relations: { views: ["~system#view"] } }),
      "Zbar Schema Error: relation 'views' on 'device' has arm '~system#view', but 'view' is not a relation on 'system'. An inverse reads the facts of a relation.",
    ],
    [
      "a walk through a permission",
      withDevice({
        relations: { parent: ["system"] },
        permissions: { up: ["parent"], view: ["up.viewer"] },
      }),
      "Zbar Schema Error: permission 'view' on 'device' has arm 'up.viewer', but 'up' is not a relation on 'device'. A walk goes through a relation (its facts are the first hop).",
    ],
    [
      "a walk whose via types declare no such set",
      withDevice({
        relations: { parent: ["system"], viewer: ["parent.nope"] },
      }),
      "Zbar Schema Error: relation 'viewer' on 'device' has arm 'parent.nope', but no type reachable through 'parent' [system] declares a set 'nope'.",
    ],
    [
      "a facts arm on a permission",
      withDevice({ permissions: { view: ["user"] } }),
      "Zbar Schema Error: permission 'view' on 'device' has facts arm 'user'; permissions are never written. Put the subject type on a relation and inherit that relation.",
    ],
    [
      "materialize on a permission",
      withDevice({
        relations: { parent: ["system"] },
        permissions: { view: [{ materialize: "parent.viewer" }] },
      }),
      "Zbar Schema Error: permission 'view' on 'device' materializes 'parent.viewer'; nothing is ever written to a permission, so only relations may be materialized.",
    ],
    [
      "materialize of an arm that is not a walk or an expansion",
      withDevice({
        relations: { admin: ["user"], viewer: [{ materialize: "admin" }] },
      }),
      "Zbar Schema Error: relation 'viewer' on 'device' has materialize('admin'); only walks ('relation.set') and expansions ('type#relation') can be materialized.",
    ],
    [
      "a materialized arm whose second hop contains a computed arm (invariant 6)",
      {
        entities: {
          user: { relations: {} },
          org: { relations: { admin: ["user"] } },
          system: { relations: { org: ["org"], admin: ["user", "org.admin"] } },
          device: {
            relations: {
              parent: ["system"],
              admin: [{ materialize: "parent.admin" }],
            },
          },
        },
      },
      "Zbar Schema Error: `device.admin`: materialized arm 'parent.admin' reads `system.admin`, which is computed at read time; materialize that arm too, or compute this one.",
    ],
    [
      "a relation and a permission with the same name",
      withDevice({
        relations: { view: ["user"] },
        permissions: { view: ["view"] },
      }),
      "Zbar Schema Error: 'view' on 'device' is declared as both a relation and a permission. A set has one name.",
    ],
    [
      "an object arm that is not materialize()",
      withDevice({ relations: { parent: [{ type: "system" }] } }),
      "Zbar Schema Error: relation 'parent' on 'device' has arm '{\"type\":\"system\"}': not an arm.",
    ],
  ])("%s", (_name, schema, message) => {
    expect(() => parseSchemaToGraphConfig(schema)).toThrow(message);
  });

  test("materializing the inner arm too makes the invariant-6 schema legal", () => {
    const config = parseSchemaToGraphConfig({
      entities: {
        user: { relations: {} },
        org: { relations: { admin: ["user"] } },
        system: {
          relations: {
            org: ["org"],
            admin: ["user", { materialize: "org.admin" }],
          },
        },
        device: {
          relations: {
            parent: ["system"],
            admin: [{ materialize: "parent.admin" }],
          },
        },
      },
    });
    expect(config.rules.map((r) => baseOf(r.key))).toEqual([
      "device.admin<=parent:system#admin(admin;)",
      "system.admin<=org:org#admin(admin;)",
    ]);
    // device.admin reads system.admin, which a rule derives: editing only that
    // upstream rule (org.admin now inherits owner) keeps device.admin's base
    // and changes its key (R1-2).
    const [device] = config.rules;
    const [edited] = parseSchemaToGraphConfig({
      entities: {
        user: { relations: {} },
        org: { relations: { owner: ["user"], admin: ["user", "owner"] } },
        system: {
          relations: {
            org: ["org"],
            admin: ["user", { materialize: "org.admin" }],
          },
        },
        device: {
          relations: {
            parent: ["system"],
            admin: [{ materialize: "parent.admin" }],
          },
        },
      },
    }).rules;
    expect(baseOf(edited.key)).toBe(baseOf(device.key));
    expect(edited.key).not.toBe(device.key);
  });
});

// ---------------------------------------------------------------------------
// CONTRACT §4.7 / §4.8: recursion is accepted (maxLineage null); an acyclic
// chain is bounded statically and must fit in maxDepth.
// ---------------------------------------------------------------------------

const lineageOf = (config: GraphConfig) =>
  Object.fromEntries(
    Object.entries(config.sets).flatMap(([type, byName]) =>
      Object.values(byName).map((s) => [`${type}.${s.name}`, s.maxLineage]),
    ),
  );

test("maxLineage: facts and inverse 1, a walk 1 + its far set, null on (or into) a cycle", () => {
  const config = parseSchemaToGraphConfig(
    createZbarSchema()
      .entity("system_user")
      .entity("system", (e) =>
        e.relation("admin", "system_user").permission("manage", "admin"),
      )
      .entity("group", (e) =>
        e
          .relation("parent", "system", "group")
          .relation("admin", "system_user")
          .relation("children", "~group#parent")
          .permission("manage", "admin", "parent.manage"),
      )
      .entity("device", (e) =>
        e.relation("group", "group").permission("manage", "group.manage"),
      )
      .build(),
  );
  expect(lineageOf(config)).toEqual({
    "device.group": 1,
    "device.manage": null, // walks into a cycle
    "group.admin": 1,
    "group.children": 1,
    "group.manage": null, // on a cycle
    "group.parent": 1,
    "system.admin": 1,
    "system.manage": 1,
  });
});

test("a mutual cycle between two types is unbounded on every member; a set outside it is not", () => {
  const config = parseSchemaToGraphConfig({
    entities: {
      user: { relations: {} },
      a: { relations: { b: ["b"], x: ["user", "b.y"] } },
      b: { relations: { a: ["a"], y: ["a.x"], z: ["user"] } },
    },
  });
  expect(lineageOf(config)).toEqual({
    "a.b": 1,
    "a.x": null,
    "b.a": 1,
    "b.y": null,
    "b.z": 1,
  });
});

test("an acyclic chain longer than maxDepth is rejected at load", () => {
  const chain = {
    entities: {
      user: { relations: {} },
      a: { relations: { viewer: ["user"] } },
      b: { relations: { up: ["a"], viewer: ["up.viewer"] } },
      c: { relations: { up: ["b"], viewer: ["up.viewer"] } },
    },
  };
  expect(
    lineageOf(parseSchemaToGraphConfig(chain, { maxDepth: 3 }))["c.viewer"],
  ).toBe(3);
  expect(() => parseSchemaToGraphConfig(chain, { maxDepth: 2 })).toThrow(
    "Zbar Schema Error: the longest derivation of 'c.viewer' uses 3 facts, more than maxDepth (2). An acyclic chain must fit: raise maxDepth or shorten the chain.",
  );
});

// ---------------------------------------------------------------------------
// Determinism: the client hashes the config, so it must not depend on the
// process, the run, or the order entities were declared in.
// ---------------------------------------------------------------------------

test("output is deterministic and independent of entity declaration order", () => {
  const schema = appSchema;
  const first = parseSchemaToGraphConfig(schema);
  const second = parseSchemaToGraphConfig(schema);
  expect(second).toEqual(first);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));

  const reversed = {
    entities: Object.fromEntries(Object.entries(schema.entities).reverse()),
  };
  expect(JSON.stringify(parseSchemaToGraphConfig(reversed))).toBe(
    JSON.stringify(first),
  );
});
