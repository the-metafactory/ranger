import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const path = process.argv[2]!;
const args = process.argv.slice(3);
const statePath = process.env.FAKE_SOMA_STATE!;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const field = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

if (process.env.GH_TOKEN !== "ghp_write") throw new Error("research forge call must use machine write token");
if (path.includes("/pulls?")) {
 console.log(JSON.stringify(state.researchPr ? [state.researchPr] : []));
} else if (path.endsWith("/pulls")) {
 const sha = spawnSync("git", ["--git-dir", process.env.FAKE_SOMA_REPO_DIR!, "rev-parse", `refs/heads/${field("head")}`], { encoding: "utf8" });
 if (sha.status !== 0) throw new Error("draft opened before findings pushed");
 state.researchPr = {
  number: 31, state: "open", draft: field("draft") === "true", merged: false,
  title: field("title"), body: field("body"),
  head: { ref: field("head"), sha: sha.stdout.trim() }, base: { ref: field("base") },
  html_url: "https://github.com/acme/widgets/pull/31", user: { login: "ivy-bot" },
 };
 state.researchPrCreates = (state.researchPrCreates ?? 0) + 1;
 save();
 console.log(JSON.stringify(state.researchPr));
} else if (path.includes("/check-runs?")) {
 const sha = path.split("/commits/")[1]!.split("/")[0];
 if (sha !== state.researchPr.head.sha) throw new Error("check runs requested for wrong head");
 const mode = process.env.FAKE_RESEARCH_CI ?? "success";
 const runs = mode === "empty" ? [] : [{ id: 901, name: "test", status: "completed", conclusion: mode }];
 console.log(JSON.stringify([{ check_runs: runs }]));
} else if (path.includes("/actions/runs?")) {
 if (!path.includes(`head_sha=${state.researchPr.head.sha}`)) throw new Error("workflow requested for wrong head");
 console.log(JSON.stringify([{ total_count: 1, workflow_runs: [{
  id: 501, workflow_id: 10, name: "test", head_sha: state.researchPr.head.sha,
  event: "pull_request", run_attempt: 1, status: "completed", conclusion: "success",
 }] }]));
} else if (path.includes("/status?")) {
 console.log(JSON.stringify([{ statuses: [] }]));
} else {
 console.log(JSON.stringify(state.researchPr));
}
