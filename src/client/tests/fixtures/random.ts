/**
 * Seeded random add/remove sequences over the appSchema universe.
 *
 * The pool is every fact the schema accepts between universe nodes: for each
 * object, each relation, each writable subject type (facts arms and expands
 * arms, S2), each universe node of that type. Each op adds an absent fact
 * (60%) or removes a present one. Deterministic: mulberry32(seed).
 */
import { appNodes, appSchemaDesc } from "./appSchema";
import { SchemaIndex } from "./derive";
import {
  add,
  describeOp,
  nodeKey,
  remove,
  type Fixture,
  type Node,
  type Op,
  type Step,
} from "./types";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Triple = { subject: Node; relation: string; object: Node };

function factPool(): Triple[] {
  const ix = new SchemaIndex(appSchemaDesc);
  const pool: Triple[] = [];
  for (const object of appNodes)
    for (const r of ix.relations(object.type))
      for (const type of ix.writableTypes(object.type, r.name))
        for (const subject of appNodes)
          if (subject.type === type && nodeKey(subject) !== nodeKey(object))
            pool.push({ subject, relation: r.name, object });
  // `system_user.self` is only ever (seat, self, seat).
  for (const s of appNodes)
    if (s.type === "system_user")
      pool.push({ subject: s, relation: "self", object: s });
  return pool.filter(
    (t) => !(t.relation === "self" && nodeKey(t.subject) !== nodeKey(t.object)),
  );
}

export function randomFixture(
  seed: number,
  opCount = 40,
  compareEvery = 10,
): Fixture {
  const rand = mulberry32(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const pool = factPool();
  const key = (t: Triple) =>
    `${nodeKey(t.subject)} ${t.relation} ${nodeKey(t.object)}`;
  const present = new Map<string, Triple>();
  const ops: Op[] = [];
  for (let i = 0; i < opCount; i++) {
    if (present.size > 0 && rand() >= 0.6) {
      const t = pick([...present.values()]);
      present.delete(key(t));
      ops.push(remove(t.subject, t.relation, t.object));
    } else {
      const t = pick(pool.filter((p) => !present.has(key(p))));
      present.set(key(t), t);
      ops.push(add(t.subject, t.relation, t.object));
    }
  }
  const steps: Step[] = [];
  for (let i = 0; i < ops.length; i += compareEvery) {
    const batch = ops.slice(i, i + compareEvery);
    steps.push({
      name: `ops ${i + 1}–${i + batch.length}: ${batch.map(describeOp).join("; ")}`,
      ops: batch,
    });
  }
  return {
    name: `random seed ${seed}`,
    schema: appSchemaDesc,
    nodes: appNodes,
    via: [appNodes[0]],
    steps,
  };
}
