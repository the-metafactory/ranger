import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTimeoutMs, graphClose } from "../src/graph-write.ts";
import { GRAPH_CALL_TIMEOUT_MS } from "../src/graph.ts";
import type { runCmd } from "../src/exec.ts";

const RECEIPT = "Closed node 5 (acme/widgets) — attestation: unverified.";

describe("closeTimeoutMs (node #347)", () => {
  test("no command probe: the graph call floor", () => {
    expect(closeTimeoutMs(undefined)).toBe(GRAPH_CALL_TIMEOUT_MS);
    expect(closeTimeoutMs([{ type: "git-ref-exists", ref: "main" }])).toBe(GRAPH_CALL_TIMEOUT_MS);
  });

  test("a command probe's timeoutSec plus margin outlasts the floor", () => {
    const ms = closeTimeoutMs([{ type: "command", run: "bun test", timeoutSec: 600, expectExit: 0 }]);
    expect(ms).toBeGreaterThan(600_000);
  });

  test("several command probes add up", () => {
    const ms = closeTimeoutMs([
      { type: "command", run: "a", timeoutSec: 300, expectExit: 0 },
      { type: "artifact-exists", path: "x" },
      { type: "command", run: "b", timeoutSec: 200, expectExit: 0 },
    ]);
    expect(ms).toBeGreaterThan(500_000);
  });

  test("a short probe never shrinks the floor", () => {
    expect(closeTimeoutMs([{ type: "command", run: "a", timeoutSec: 5, expectExit: 0 }])).toBeGreaterThanOrEqual(GRAPH_CALL_TIMEOUT_MS);
  });
});

describe("graphClose against a stub soma that forks (node #347)", () => {
  let dir = "";
  let env: NodeJS.ProcessEnv;

  const stub = (body: string): NodeJS.ProcessEnv => {
    writeFileSync(join(dir, "soma"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, "soma"), 0o755);
    return { ...env, PATH: `${dir}:${process.env.PATH ?? ""}` };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ranger-close-stub-"));
    env = { ...process.env };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const options = { resolutionFile: "/tmp/r.md" };

  test("a close that outlives the timeout via a grandchild is a timeout, never soma's output", async () => {
    const marker = join(dir, "grandchild-ran");
    const runEnv = stub(`( sleep 1.2; echo '${RECEIPT}'; touch '${marker}' ) &\nwait`);
    const result = await graphClose("acme/widgets", "5", "ivy-agent", "tok", options, { env: runEnv, timeoutMs: 300 });
    expect(result.closed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.detail).toContain("timed out");
    expect(result.detail).not.toContain("Closed node");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("a close that finishes inside its timeout returns closed with the receipt", async () => {
    const runEnv = stub(`sleep 0.4\necho '${RECEIPT}'`);
    const timeoutMs = closeTimeoutMs([{ type: "command", run: "slow probe", timeoutSec: 1, expectExit: 0 }]);
    const result = await graphClose("acme/widgets", "5", "ivy-agent", "tok", options, { env: runEnv, timeoutMs });
    expect(result).toMatchObject({ closed: true, detail: RECEIPT });
    expect(result.timedOut).toBeUndefined();
  });

  test("a refusal is still closed:false with soma's text and no timeout flag", async () => {
    const runEnv = stub(`echo 'refused: gate failed' >&2\nexit 1`);
    const result = await graphClose("acme/widgets", "5", "ivy-agent", "tok", options, { env: runEnv, timeoutMs: 5_000 });
    expect(result).toMatchObject({ closed: false, detail: "refused: gate failed" });
    expect(result.timedOut).toBeUndefined();
  });

  test("a runner reporting timedOut yields a timeout result, discarding its stdout", async () => {
    const runner = (async () => ({ code: -1, stdout: RECEIPT, stderr: "", timedOut: true })) as unknown as typeof runCmd;
    const result = await graphClose("acme/widgets", "5", "ivy-agent", "tok", options, { runner, timeoutMs: 90_000 });
    expect(result).toMatchObject({ closed: false, timedOut: true });
    expect(result.detail).toContain("90s");
    expect(result.detail).not.toContain("Closed node");
  });

  test("the close call runs as its own process group", async () => {
    let seen: boolean | undefined;
    const runner = (async (_cmd: string, _args: string[], opts: { processGroup?: boolean }) => {
      seen = opts.processGroup;
      return { code: 0, stdout: RECEIPT, stderr: "" };
    }) as unknown as typeof runCmd;
    await graphClose("acme/widgets", "5", "ivy-agent", "tok", options, { runner });
    expect(seen).toBe(true);
  });

  test("an omitted timeout uses and reports the graph call floor", async () => {
    let seen: number | undefined;
    const runner: typeof runCmd = async (_cmd, _args, opts) => {
      seen = opts?.timeoutMs;
      return { code: -1, stdout: RECEIPT, stderr: "", timedOut: true };
    };
    const result = await graphClose("acme/widgets", "5", "ivy-agent", "tok", options, { runner });
    expect(seen).toBe(GRAPH_CALL_TIMEOUT_MS);
    expect(result.detail).toContain(`${GRAPH_CALL_TIMEOUT_MS / 1000}s`);
  });
});
