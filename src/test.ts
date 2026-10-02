/// <reference types="vite/client" />
/**
 * convex-test harness for the engine (`convzibar/test`).
 *
 * Imports test-only packages (`convex-test`, the workpool's test register),
 * so it is excluded from the build and must not be imported by app code.
 */
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { convexTest, type TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import componentSchema from "./component/schema";

const modules = import.meta.glob("./component/**/*.ts");

/**
 * The engine as the ROOT of a convex-test instance: call its functions through
 * `api` from `convzibar/_generated/component`, or hand a
 * `{ runQuery, runMutation }` ctx bound to it to a `Zbar` client built on that
 * `api`.
 */
export function zbarEngineTest() {
  const t = convexTest(componentSchema, modules);
  registerWorkpool(t, "workpool");
  return t;
}

/**
 * Mount the engine (and its nested workpool) inside an app-level convex-test
 * instance at the same path the app's convex.config.ts uses, so
 * `components.<name>` resolves to it.
 */
export function registerZbarComponent(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name = "convzibar",
) {
  t.registerComponent(name, componentSchema, modules);
  registerWorkpool(t, `${name}/workpool`);
}

/** 2.x name for `registerZbarComponent`. */
export const register = registerZbarComponent;

export default {
  register,
  registerZbarComponent,
  zbarEngineTest,
  schema: componentSchema,
  modules,
};
