/**
 * EXPANSION.md P2 (order independence): whatever the interleaving of writes
 * and chunks, the drained table is exact for the facts present — its rows are
 * E*(F) and every row's minimal paths are Min Λ_F(k) of the independent
 * reference evaluator.
 *
 * `writeBudget: 2` makes every chunk process exactly one range entry, so the
 * parked cursors interleave at the finest grain the engine has.
 */
import { zbarEngineTest } from "../../test";
import { describe, test } from "vitest";
import {
  ALL_RULES,
  type Task,
  drain,
  engine,
  expectExact,
  graphConfig,
  parked,
  prng,
  runTask,
} from "./expansion-harness";

const DEPTH = 5; // low enough that the recursive walk hits it

// Fact shapes valid under ALL_RULES, over a small universe (collisions wanted).
const pick = <T>(rand: () => number, xs: T[]) =>
  xs[Math.floor(rand() * xs.length)];
const users = ["user:u1", "user:u2"];
const squads = ["squad:s1"];
const teams = ["team:t1"];
const groups = ["group:g1", "group:g2", "group:g3"];
const devices = ["device:d1", "device:d2"];
const nrules = ["nrule:r1", "nrule:r2"];

function randomFact(rand: () => number): [string, string, string] {
  switch (Math.floor(rand() * 9)) {
    case 0:
      return [pick(rand, users), "member", pick(rand, squads)];
    case 1:
      return [pick(rand, squads), "member", pick(rand, teams)];
    case 2:
      return [pick(rand, users), "member", pick(rand, teams)];
    case 3:
      return [pick(rand, teams), "viewer", "org:o1"];
    case 4:
      return [pick(rand, users), "manage", pick(rand, groups)];
    case 5:
    case 6:
      return [pick(rand, groups), "parent", pick(rand, groups)]; // cycles and self-loops
    case 7:
      return [pick(rand, groups), "source", pick(rand, nrules)];
    default:
      return [pick(rand, groups), "holds", pick(rand, devices)];
  }
}

type Schedule = (rand: () => number) => (tasks: Task[]) => number;
const schedules: Record<string, Schedule> = {
  fifo: () => () => 0,
  lifo: () => (tasks) => tasks.length - 1,
  random: (rand) => (tasks) => Math.floor(rand() * tasks.length),
  // Every removal before any addition, then the reverse: the two extremes of
  // "remove while adding".
  removalsFirst: () => (tasks) =>
    Math.max(
      0,
      tasks.findIndex((x) => x.args.items[0].kind === "remove"),
    ),
  additionsFirst: () => (tasks) =>
    Math.max(
      0,
      tasks.findIndex((x) => x.args.items[0].kind === "add"),
    ),
};

async function scenario(seed: number, schedule: Schedule) {
  const rand = prng(seed);
  const order = schedule(rand);
  const t = zbarEngineTest();
  const z = engine(
    t,
    graphConfig(ALL_RULES, { writeBudget: 2, maxDepth: DEPTH }),
  );
  const written: [string, string, string][] = [];

  for (let op = 0; op < 40; op++) {
    const roll = rand();
    if (roll < 0.5 || written.length === 0) {
      const f = randomFact(rand);
      await z.add(...f);
      written.push(f);
    } else if (roll < 0.8) {
      await z.remove(...pick(rand, written));
    } else if (roll < 0.92) {
      // replace whatever a user holds on a team with `member`, or on a squad
      await z.set(
        pick(rand, users),
        "member",
        pick(rand, [...teams, ...squads]),
        ["member", "viewer"],
      );
    } else {
      await z.deleteEntity(pick(rand, [...squads, ...groups, ...teams]));
    }
    // Let a random number of parked chunks run between writes.
    for (let k = Math.floor(rand() * 4); k > 0; k--) {
      const tasks = await parked(t);
      if (tasks.length === 0) break;
      await runTask(t, tasks[order(tasks)]);
    }
  }
  await drain(t, order);
  await expectExact(t, ALL_RULES, DEPTH);
}

describe("P2 order independence: drained table = least fixed point of the rules", () => {
  for (const [name, schedule] of Object.entries(schedules)) {
    const seeds =
      name === "random"
        ? Array.from({ length: 30 }, (_, i) => i + 1)
        : [101, 102, 103, 104, 105];
    for (const seed of seeds) {
      test(`${name} schedule, seed ${seed}`, async () => {
        await scenario(seed, schedule);
      }, 60_000);
    }
  }
});
