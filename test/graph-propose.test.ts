import { describe, expect, test } from "bun:test";
import { graphPropose, parseProposal } from "../src/graph-write.ts";
import { proposalBody, proposalMarker } from "../src/worker.ts";
import type { runCmd } from "../src/exec.ts";

describe("parseProposal (node #246, rulings D8 + D18)", () => {
  test("soma's text output: the id from `Posted proposal comment <id>`, the url line", () => {
    const out = "Posted proposal comment 4242 on node 10 (acme/widgets).\nurl: https://github.com/acme/widgets/issues/10#issuecomment-4242\n\nThe receipt is …";
    expect(parseProposal(out)).toEqual({ commentId: "4242", commentUrl: "https://github.com/acme/widgets/issues/10#issuecomment-4242" });
  });

  test("a JSON payload's id wins", () => {
    expect(parseProposal(JSON.stringify({ node: "10", commentId: 77, url: "https://github.com/a/b/issues/10#issuecomment-77" })))
      .toEqual({ commentId: "77", commentUrl: "https://github.com/a/b/issues/10#issuecomment-77" });
    expect(parseProposal(JSON.stringify({ comment: { id: "78" } }))).toEqual({ commentId: "78", commentUrl: null });
  });

  test("no id anywhere → null, never a guess", () => {
    expect(parseProposal("Proposal posted.")).toEqual({ commentId: null, commentUrl: null });
    expect(parseProposal(JSON.stringify({ node: "10", commentId: "not-a-number" }))).toEqual({ commentId: null, commentUrl: null });
    expect(parseProposal("Posted proposal comment abc")).toEqual({ commentId: null, commentUrl: null });
  });
});

describe("graphPropose", () => {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const runner = (code: number, stdout: string, stderr = ""): typeof runCmd =>
    (async (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) => {
      calls.push({ cmd, args, env: opts.env });
      return { code, stdout, stderr };
    }) as typeof runCmd;

  test("runs close --propose --body-file under the bot identity, never with --resolution-file or --dry-run", async () => {
    calls.length = 0;
    const result = await graphPropose("acme/widgets", "10", "ivy-agent", "machine-token", { bodyFile: "/tmp/body.md" }, {
      runner: runner(0, "Posted proposal comment 5 on node 10 (acme/widgets).\n"),
    });
    expect(result).toMatchObject({ posted: true, commentId: "5", node: "10" });
    const args = calls[0]!.args;
    expect(calls[0]!.cmd).toBe("soma");
    expect(args.slice(0, 6)).toEqual(["graph", "close", "10", "--propose", "--body-file", "/tmp/body.md"]);
    expect(args).toContain("--json");
    expect(args).not.toContain("--resolution-file");
    expect(args).not.toContain("--dry-run");
    expect(args[args.indexOf("--identity") + 1]).toBe("ivy-agent");
    expect(args[args.indexOf("--repo") + 1]).toBe("github:github.com/acme/widgets");
  });

  test("a refusal is not posted and carries the reason", async () => {
    const result = await graphPropose("acme/widgets", "10", "ivy-agent", "machine-token", { bodyFile: "/tmp/body.md" }, {
      runner: runner(1, "", "Node 10 has no attached checkpoint"),
    });
    expect(result).toMatchObject({ posted: false, commentId: null, detail: "Node 10 has no attached checkpoint" });
  });
});

describe("proposalBody", () => {
  const args = {
    repo: "acme/widgets",
    nodeId: "10",
    findings: "# Findings\n\nThe API fits.",
    branch: "research/api-survey",
    sha: "0123456789abcdef0123",
    draftUrl: "https://github.com/acme/widgets/pull/31",
    ci: "check run 901@0123",
  };

  test("findings, branch link, CI draft, the 👍 instruction, and the binding marker last", () => {
    const body = proposalBody(args);
    expect(body.startsWith("# Findings")).toBe(true);
    expect(body).toContain("https://github.com/acme/widgets/tree/research/api-survey (head `0123456789ab`)");
    expect(body).toContain("draft https://github.com/acme/widgets/pull/31, check run 901@0123");
    expect(body).toContain("React 👍 on this comment");
    expect(body.endsWith(proposalMarker("10"))).toBe(true);
    expect(proposalMarker("10")).toBe("<!-- ranger:proposal node=10 -->");
  });

  test("long findings are cut to fit a GitHub comment and point at the branch", () => {
    const body = proposalBody({ ...args, findings: "x".repeat(80_000) });
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("which holds the full findings");
  });
});
