import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { privateOperatorPath } from "../src/remote-test/baseline.ts";
import { submitSshRemoteTest, statusSshRemoteTest } from "../src/remote-test/ssh-client.ts";

// An operator-prepared DISPOSABLE endpoint and fresh immutable job only. The
// fixture and all configuration stay private; this never provisions a host.
const fixturePath = process.env.RANGER_SSH_INTEGRATION_FIXTURE;
test.skipIf(!fixturePath)("opt-in disposable SSH endpoint executes once and retrieves the exact same durable receipt", async () => {
 const fixture = z.object({ config: z.unknown(), job: z.unknown(), bundlePath: z.string() }).strict().parse(
  JSON.parse(await readFile(await privateOperatorPath(fixturePath!, true), "utf8")));
 const input = { config: fixture.config, job: fixture.job, bundlePath: fixture.bundlePath };
 const submitted = await submitSshRemoteTest(input);
 expect(submitted.status).toBe("terminal");
 if (submitted.status !== "terminal") return;
 expect(submitted.receipt.status).toBe("passed");
 const retrieved = await statusSshRemoteTest(input);
 expect(retrieved.status).toBe("terminal");
 if (retrieved.status === "terminal") expect(retrieved.receipt).toEqual(submitted.receipt);
}, 900_000);
