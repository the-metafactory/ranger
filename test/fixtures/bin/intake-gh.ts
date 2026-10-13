import { readFileSync } from "node:fs";

/**
 * The intake gate's marker lookup (node #251), from the fake soma state:
 * every issue in `state.issues` carrying the asked label, printed the way
 * `gh api --paginate --slurp` prints it (one page). FAKE_GH_INTAKE_FAIL=exit
 * fails the read.
 */

const path = process.argv[2]!;
if (process.env.GH_TOKEN !== "ghp_write") throw new Error("the marker lookup must run under the machine write credential");
const label = decodeURIComponent(/[?&]labels=([^&]+)/.exec(path)![1]!);
if (!/[?&]state=all(&|$)/.test(path)) throw new Error("the marker lookup must list closed issues too");
if (process.env.FAKE_GH_INTAKE_FAIL === "exit") {
 console.error("gh: HTTP 403 Forbidden");
 process.exit(1);
}
const state = JSON.parse(readFileSync(process.env.FAKE_SOMA_STATE!, "utf8"));
const issues = Object.values(state.issues ?? {}) as { number: number; labels: string[]; body: string; machineAccount: boolean }[];
// The author is the write token's login (fake gh's /user): the machine account, or someone else.
const author = (i: { machineAccount: boolean }) => ({ login: i.machineAccount ? "ivy-bot" : "someone-else" });
console.log(JSON.stringify([issues.filter((i) => i.labels.includes(label)).map((i) => ({ number: i.number, body: i.body, user: author(i) }))]));
