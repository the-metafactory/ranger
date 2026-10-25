// Drive the verification dashboard in headless Chromium and write evidence.
// usage: bun drive.ts <run-dir> [--refresh]
// Every POST except /api/refresh is aborted: approve, merge, resume, build-now,
// grill and drain run ~/bin/ranger with the principal's write tokens.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLAYWRIGHT = `${process.env.HOME}/.bun/install/global/node_modules/playwright/index.mjs`;
const { chromium } = await import(process.env.VERIFY_RANGER_PLAYWRIGHT ?? PLAYWRIGHT);

const [run, ...flags] = Bun.argv.slice(2);
if (!run) throw new Error("usage: bun drive.ts <run-dir> [--refresh]");
const port = (await Bun.file(join(run, "state", "port")).text()).trim();
const base = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = (name: string) => join(run, "evidence", `${stamp}-${name}`);
const netLog = out("network.log");
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

type State = {
  maps: { key: string; grillings: { id: string }[]; error?: string }[];
  needsYou: unknown[];
  needsYouUnchecked?: unknown[];
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("dialog", (d: { dismiss: () => Promise<void> }) => d.dismiss());
  await page.route("**/api/**", async (route: any) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const allowed = req.method() === "GET" || path === "/api/refresh";
    appendFileSync(netLog, `${new Date().toISOString()} ${req.method()} ${path} ${allowed ? "sent" : "BLOCKED"}\n`);
    return allowed ? route.continue() : route.abort();
  });

  const rendered = page.waitForResponse((r: any) => new URL(r.url()).pathname === "/api/state");
  await page.goto(base + "/");
  const state = (await (await rendered).json()) as State;
  await page.waitForFunction(() => document.getElementById("meta")?.textContent !== "loading…", null, { timeout: 30_000 });
  const guard = await page.evaluate(() => fetch("/api/merge", { method: "POST" }).then(() => "sent", () => "blocked"));
  check(guard === "blocked", `guard aborts action POSTs (/api/merge ${guard})`);
  await page.screenshot({ path: out("dashboard.png"), fullPage: true });

  writeFileSync(out("state.json"), JSON.stringify(state, null, 2));
  const dom = await page.evaluate(() => ({
    meta: document.getElementById("meta")?.textContent ?? "",
    msg: document.getElementById("msg")?.textContent ?? "",
    needsCards: document.getElementById("needsyou")?.children.length ?? 0,
    grillIds: [...document.querySelectorAll("#grill .id")].map((e) => (e.textContent ?? "").trim()),
    sections: [...document.querySelectorAll("main h2")].map((h) => h.textContent),
  }));
  writeFileSync(out("dom.json"), JSON.stringify(dom, null, 2));

  check(!dom.msg.includes("Could not read state"), `page read /api/state (msg: "${dom.msg}")`);
  check(dom.sections.length === 6, `six sections rendered: ${dom.sections.join(" | ")}`);
  const unchecked = (state.needsYouUnchecked ?? []).length > 0 ? 1 : 0;
  const expectedNeeds = state.needsYou.length === 0 && unchecked === 0 ? 1 : state.needsYou.length + unchecked;
  check(dom.needsCards === expectedNeeds, `Needs you shows ${dom.needsCards} entries, state implies ${expectedNeeds}`);
  const grillIds = state.maps.flatMap((m) => m.grillings.map((g) => `#${g.id}`));
  const shown = new Set(dom.grillIds);
  const missing = grillIds.filter((id) => !shown.has(id));
  check(missing.length === 0, `all ${grillIds.length} grillings in state appear under "Needs your decision"${missing.length ? `; missing ${missing.join(",")}` : ""}`);

  if (flags.includes("--refresh")) {
    const posted = page.waitForResponse((r: any) => new URL(r.url()).pathname === "/api/refresh");
    await page.click("#refresh");
    const res = await posted;
    check(res.status() === 202, `Refresh posted /api/refresh -> ${res.status()}`);
    await page.waitForFunction(() => /Refreshing/.test(document.getElementById("msg")?.textContent ?? ""), null, { timeout: 5_000 });
    await page.screenshot({ path: out("after-refresh.png"), fullPage: true });
  }
} finally {
  await browser.close();
}
console.log(`evidence: ${out("*")}`);
process.exit(failures.length === 0 ? 0 : 1);
