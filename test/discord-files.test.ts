import { describe, expect, test } from "bun:test";
import { DiscordClient, DISCORD_MAX_FILE_BYTES, DISCORD_MAX_FILES_BYTES, type DiscordFile } from "../src/discord.ts";

function client(fetchFn: typeof fetch) {
 return new DiscordClient("bot-secret", "123", "https://discord.com/api/v10", "456", undefined, fetchFn);
}
const files: DiscordFile[] = [
 { name: "hull-before.png", description: "hull: before", data: new Blob(["before"], { type: "image/png" }) },
 { name: "hull-after.png", description: "hull: after", data: new Blob(["after"], { type: "image/png" }) },
];
describe("Discord multipart files", () => {
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
