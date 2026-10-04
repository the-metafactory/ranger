import { mock } from "bun:test";
import * as worker from "../../src/worker.ts";

const runNode = worker.runNode;
mock.module("../../src/worker.ts", () => ({
 ...worker,
 runNode: (nodeId: string, ctx: Parameters<typeof runNode>[1]) =>
  runNode(nodeId, { ...ctx, researchCiTiming: { settleMs: 0, pollMs: 10 } }),
}));
