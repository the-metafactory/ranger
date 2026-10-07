import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshRunner } from "../src/remote-test/ssh-client.ts";

let root: string | undefined;
const oldPath = process.env.PATH;
afterEach(async () => { process.env.PATH = oldPath; if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
async function executable(program: string) {
 root = await realpath(await mkdtemp(join(tmpdir(), "ranger-ssh-runner-")));
 await writeFile(join(root, "ssh"), `#!${process.execPath}\n${program}`, { mode: 0o700 });
 process.env.PATH = `${root}:${oldPath}`;
}
const input = (bytes = Buffer.from("bounded request")) => (async function* () { yield bytes; })();
test("real SSH subprocess seam feeds stdin, drains stderr, and excludes inherited forge/bus secrets", async () => {
 await executable('for await (const _ of process.stdin) {} process.stderr.write("private diagnostic".repeat(10000)); console.log(JSON.stringify({ blocked: ["GH_TOKEN", "NATS_TOKEN", "RANGER_JOURNAL_PATH"].some(k => k in process.env) }));');
 const result = await sshRunner({ args: [], input: input(), timeoutMs: 3000 }); expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ blocked: false });
});
test("bounded SSH stdout and timeout fail transport; early peer close during large stdin cannot hang", async () => {
 await executable('console.log("a".repeat(100000)); await new Promise(() => {});');
 expect((await sshRunner({ args: [], input: input(), timeoutMs: 500 })).code).not.toBe(0);
 await writeFile(join(root!, "ssh"), `#!${process.execPath}\nawait new Promise(() => {});`, { mode: 0o700 });
 expect((await sshRunner({ args: [], input: input(), timeoutMs: 200 })).code).not.toBe(0);
 await writeFile(join(root!, "ssh"), `#!${process.execPath}\nprocess.exit(255);`, { mode: 0o700 });
 expect((await sshRunner({ args: [], input: input(Buffer.alloc(8 * 1024 ** 2)), timeoutMs: 3000 })).code).not.toBe(0);
});
test("aborted SSH child is killed and a preaborted call never spawns", async () => {
 await executable('for await (const _ of process.stdin) {} await new Promise(() => {});');
 const abort = new AbortController(); const running = sshRunner({ args: [], input: input(), timeoutMs: 3000, signal: abort.signal }); setTimeout(() => abort.abort(), 100);
 expect((await running).code).not.toBe(0);
 await expect(sshRunner({ args: [], input: input(), timeoutMs: 3000, signal: abort.signal })).rejects.toThrow("interrupted");
});
