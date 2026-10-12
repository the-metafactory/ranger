import { readFileSync, writeFileSync } from "node:fs";

/**
 * The ratify phase's GitHub reads (node #250), from the fake soma state:
 * `state.reactions[commentId]` and `state.comments[node]` are lists of
 * pages, printed the way `gh api --paginate --slurp` prints them.
 * FAKE_GH_RATIFY_FAIL=exit fails the read; =page answers one page that is
 * not a list (a page missing).
 *
 * A POST to an issue's comments (node #240, the veto comment) appends the
 * comment to the last page of `state.comments[node]` under the machine
 * account, and prints it. FAKE_GH_COMMENT_FAIL fails the POST.
 */

const path = process.argv[2]!;
if (process.env.GH_TOKEN !== "ghp_write") throw new Error("ratify reads must use the machine write token");
const state = JSON.parse(readFileSync(process.env.FAKE_SOMA_STATE!, "utf8"));
const post = /\/issues\/(\d+)\/comments$/.exec(path);
if (post !== null) {
 if (process.env.FAKE_GH_COMMENT_FAIL) {
  console.error("gh: HTTP 502 Bad Gateway");
  process.exit(1);
 }
 const args = process.argv.slice(3);
 const body = args[args.indexOf("-f") + 1]!.replace(/^body=/, "");
 const id = state.nextCommentId ?? 9500;
 const comment = { id, user: { login: "ivy-bot" }, body };
 const pages: unknown[][] = (state.comments ??= {})[post[1]!] ??= [[]];
 pages[pages.length - 1]!.push(comment);
 state.nextCommentId = id + 1;
 writeFileSync(process.env.FAKE_SOMA_STATE!, JSON.stringify(state));
 console.log(JSON.stringify(comment));
 process.exit(0);
}
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
