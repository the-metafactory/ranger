import { readFileSync } from "node:fs";

/**
 * The ratify phase's GitHub reads (node #250), from the fake soma state:
 * `state.reactions[commentId]` and `state.comments[node]` are lists of
 * pages, printed the way `gh api --paginate --slurp` prints them.
 * FAKE_GH_RATIFY_FAIL=exit fails the read; =page answers one page that is
 * not a list (a page missing).
 */

const path = process.argv[2]!;
if (process.env.GH_TOKEN !== "ghp_write") throw new Error("ratify reads must use the machine write token");
const state = JSON.parse(readFileSync(process.env.FAKE_SOMA_STATE!, "utf8"));
const reactions = /\/issues\/comments\/(\d+)\/reactions\?/.exec(path);
const comments = /\/issues\/(\d+)\/comments\?/.exec(path);
const pages: unknown[][] = reactions !== null
 ? state.reactions?.[reactions[1]!] ?? [[]]
 : state.comments?.[comments![1]!] ?? [[]];
const fail = process.env.FAKE_GH_RATIFY_FAIL;
if (fail === "exit") {
 console.error("gh: HTTP 502 Bad Gateway (page 2)");
 process.exit(1);
}
console.log(JSON.stringify(fail === "page" ? [...pages, { message: "Server Error" }] : pages));
