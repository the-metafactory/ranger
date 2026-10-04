import { describe, expect, test } from "bun:test";
import { EscalationDiscord, DISCORD_MAX_FILE_BYTES, DISCORD_MAX_FILES_BYTES, type DiscordFile } from "../src/discord.ts";
import { AnnounceError, DiscordAnnouncer } from "../src/announce.ts";

function client(fetchFn: typeof fetch) {
 return new EscalationDiscord("bot-secret", "123", "https://discord.com/api/v10", "456", undefined, fetchFn);
}
const files: DiscordFile[] = [
 { name: "hull-before.png", description: "hull: before", data: new Blob(["before"], { type: "image/png" }) },
 { name: "hull-after.png", description: "hull: after", data: new Blob(["after"], { type: "image/png" }) },
];
describe("Discord multipart files", () => {
 test("announcer forwards files and embeds through retry handling", async () => {
  let calls = 0;
  const fetchFn = (async (_url, init) => {
   const form = init!.body as FormData;
   expect(form).toBeInstanceOf(FormData);
   const payload = JSON.parse(form.get("payload_json") as string);
   expect(payload.allowed_mentions).toEqual({ parse: [], users: [] });
   expect(payload.embeds).toEqual([{ description: "diff" }]);
   expect(payload.attachments.map((f: { filename: string }) => f.filename)).toEqual(files.map(f => f.name));
   expect(await (form.get("files[0]") as File).text()).toBe("before");
   if (++calls === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0.001" } });
   return Response.json({ id: "789" });
  }) as typeof fetch;
  const announcer = new DiscordAnnouncer("bot-secret", "123", undefined, fetchFn);
  expect(await announcer.post("card", "merge card for node 52", files, [{ description: "diff" }])).toBe("789");
  expect(calls).toBe(2);
 });
 test.each([403, 200])("announcer preserves label and fail-closed error on HTTP %p or missing id", async status => {
  const fetchFn = (async () => Response.json({}, { status })) as unknown as typeof fetch;
  const announcer = new DiscordAnnouncer("bot-secret", "123", undefined, fetchFn);
  try {
   await announcer.post("card", "merge card for node 52", files);
   throw new Error("post must fail");
  } catch (error) {
   expect(error).toBeInstanceOf(AnnounceError);
   expect((error as Error).message).toContain("merge card for node 52");
   expect((error as Error).message).toContain("fail-closed");
   expect((error as Error).message).toContain(status === 403 ? "HTTP 403" : "no message id");
  }
 });
 test("payload_json plus files[n], metadata and mention suppression; fetch sets the boundary", async () => {
  let called = false;
  const fetchFn = (async (url, init) => {
   called = true;
   expect(url.toString()).toBe("https://discord.com/api/v10/channels/123/messages");
   expect(init?.method).toBe("POST");
   expect((init?.headers as Record<string, string>).Authorization).toBe("Bot bot-secret");
   expect(new Headers(init?.headers).has("content-type")).toBe(false);
   expect(init?.body).toBeInstanceOf(FormData);
   const form = init!.body as FormData;
   const payload = JSON.parse(form.get("payload_json") as string);
   expect(payload).toEqual({ content: "card", allowed_mentions: { parse: [], users: ["456"] }, attachments: [
    { id: 0, filename: "hull-before.png", description: "hull: before" },
    { id: 1, filename: "hull-after.png", description: "hull: after" },
   ] });
   expect([...form.keys()]).toEqual(["payload_json", "files[0]", "files[1]"]);
   expect((form.get("files[0]") as File).name).toBe("hull-before.png");
   expect((form.get("files[0]") as File).type).toBe("image/png");
   expect(await (form.get("files[1]") as File).text()).toBe("after");
   return Response.json({ id: "789" });
  }) as typeof fetch;
  expect(await client(fetchFn).post("card", undefined, files)).toBe("789");
  expect(called).toBe(true);
 });
 test("no files keeps the JSON request", async () => {
  const fetchFn = (async (_url, init) => {
   expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
   expect(typeof init?.body).toBe("string");
   expect(JSON.parse(init?.body as string).attachments).toBeUndefined();
   return Response.json({ id: "789" });
  }) as typeof fetch;
  await client(fetchFn).post("plain");
 });
 test("multipart retries 429 and 5xx through the existing request loop", async () => {
  let calls = 0;
  const fetchFn = (async (_url, init) => {
   expect(init?.body).toBeInstanceOf(FormData);
   expect(await ((init!.body as FormData).get("files[0]") as File).text()).toBe("before");
   calls++;
   if (calls < 3) return new Response("busy", { status: calls === 1 ? 429 : 503, headers: { "retry-after": "0.001" } });
   return Response.json({ id: "789" });
  }) as typeof fetch;
  expect(await client(fetchFn).post("card", undefined, files)).toBe("789");
  expect(calls).toBe(3);
 });
 test("refuses over-count, per-file and total limits before fetch", async () => {
  const fetchFn = (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
  await expect(client(fetchFn).post("card", undefined, Array.from({ length: 11 }, () => files[0]))).rejects.toThrow("too many");
  await expect(client(fetchFn).post("card", undefined, [{ name: "big.png", data: new Blob([new Uint8Array(DISCORD_MAX_FILE_BYTES + 1)]) }])).rejects.toThrow("too large");
  const data = new Blob([new Uint8Array(Math.ceil(DISCORD_MAX_FILES_BYTES / 3) + 1)]);
  await expect(client(fetchFn).post("card", undefined, Array.from({ length: 3 }, () => ({ name: "big.png", data })))).rejects.toThrow("request budget");
 });
});
