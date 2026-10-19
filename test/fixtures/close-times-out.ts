import { mock } from "bun:test";
import * as graphWrite from "../../src/graph-write.ts";

const graphClose = graphWrite.graphClose;
mock.module("../../src/graph-write.ts", () => ({
 ...graphWrite,
 graphClose: (...[repo, id, identity, token, options, opts]: Parameters<typeof graphClose>) => graphClose(repo, id, identity, token, options, {
  ...opts,
  runner: async () => ({ code: -1, stdout: "Closed node 10 (acme/widgets)", stderr: "", timedOut: true }),
 }),
}));
