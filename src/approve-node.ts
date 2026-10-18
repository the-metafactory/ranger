import { executableApproval, approvalVersion, NODE_BLOCK } from "./approval-spec.ts";
import { principalLoginForRepo, type RangerConfig, type RangerMapConfig } from "./config.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { childEnv } from "./launch.ts";
import { runCmd } from "./exec.ts";

export async function approveNode(args: {
 config: RangerConfig;
 map: RangerMapConfig;
 id: string;
 version: string;
 dryRun?: boolean;
}, runner: typeof runCmd = runCmd): Promise<{ approved: boolean; dryRun: boolean }> {
 if (!/^\d+$/.test(args.id) || !/^[a-f0-9]{64}$/.test(args.version)) throw new Error("invalid node id or approval version");
 if (args.map.walk !== "full" || (args.map.nodes !== undefined && !args.map.nodes.includes(args.id))) throw new Error("node is outside this map's implementation scope");
 const ref = parseForgeRef(args.map.repo);
 const principal = principalLoginForRepo(args.config, args.map.repo);
 if (!principal) throw new Error("no principal login configured for approval");
 const bot = args.config.bot.identity;
 if (!bot) throw new Error("no bot identity configured for execution");
 const env = childEnv(process.env);
 const github = ref.forge === "github";
 const cli = github ? "gh" : "glab";
 const endpoint = github ? `repos/${ref.path}/issues/${args.id}` : `projects/${encodeURIComponent(ref.path)}/issues/${args.id}`;
 const call = async (path: string, method = "GET", input?: unknown): Promise<Record<string, unknown>> => {
  const result = await runner(cli, ["api", path, "--hostname", ref.host, "--method", method, ...(input === undefined ? [] : ["--input", "-"])], {
   env, timeoutMs: 30_000, ...(input === undefined ? {} : { stdin: JSON.stringify(input) }),
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${cli} approval call failed`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
 };
 const user = await call("user");
 const login = github ? user.login : user.username;
 if (typeof login !== "string" || login.toLowerCase() !== principal.toLowerCase()) throw new Error(`approval requires the principal's ${cli} login (${principal})`);
 const issue = await call(endpoint);
 const body = github ? issue.body : issue.description;
 if (typeof body !== "string" || typeof issue.title !== "string") throw new Error("node body or title is unreadable");
 const blocks = [...body.matchAll(NODE_BLOCK)];
 if (blocks.length !== 1) throw new Error("approval requires exactly one typed node block");
 const spec = JSON.parse(blocks[0][1]) as Record<string, unknown>;
 if (!executableApproval({ kind: String(spec.kind), autonomy: String(spec.autonomy) })) throw new Error("only approve task/build nodes can be approved for execution");
 if (!["open", "opened"].includes(String(issue.state)) || !Array.isArray(issue.assignees) || issue.assignees.length > 0) throw new Error("node is no longer open and unclaimed");
 if (github && issue.pull_request !== undefined) throw new Error("approval requires an issue, not a pull request");
 const author = github ? (issue.user as { login?: string } | undefined)?.login : (issue.author as { username?: string } | undefined)?.username;
 if (typeof author !== "string" || !author.trim()) throw new Error("node author is unreadable");
 if (author.toLowerCase() === bot.toLowerCase()) throw new Error("bot-authored nodes require the principal intake workflow before execution");
 if (approvalVersion({ ...spec, title: issue.title }, body) !== args.version) throw new Error("node changed since the card was read; refresh before approving");
 if (args.dryRun) return { approved: false, dryRun: true };
 const current = await call(endpoint);
 if (JSON.stringify([current.title, current.state, current.assignees, github ? current.body : current.description]) !== JSON.stringify([issue.title, issue.state, issue.assignees, body])) throw new Error("node changed during approval; refresh before approving");
 const approved = body.replace(NODE_BLOCK, () => `<!-- soma:work-graph-node\n${JSON.stringify({ ...spec, autonomy: "propose" }, null, 2)}\n-->`) +
  `\n\nRanger execution approved by @${login} on ${new Date().toISOString()}. Existing review and merge gates apply.\n`;
 await call(endpoint, github ? "PATCH" : "PUT", github ? { body: approved } : { description: approved });
 const saved = await call(endpoint);
 if ((github ? saved.body : saved.description) !== approved) throw new Error("approval write could not be confirmed; refresh before retrying");
 return { approved: true, dryRun: false };
}
