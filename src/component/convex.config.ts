import { defineComponent } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config.js";

const component = defineComponent("convzibar");
component.use(workpool);

export default component;
