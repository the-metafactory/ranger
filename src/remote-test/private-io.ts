import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { privateOperatorPath } from "./baseline.ts";

export async function readPrivateJson(path: string) {
 const file = await open(await privateOperatorPath(path, true), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await file.stat(); if (!info.isFile() || info.size > 65_536) throw Error("Invalid private JSON input");
  return JSON.parse(await file.readFile("utf8"));
 } finally { await file.close(); }
}
export async function reserve(path: string) {
 const destination = await privateOperatorPath(path), reservation = `${destination}.reservation`;
 await mkdir(reservation, { mode: 0o700 });
 try {
  try { await lstat(destination); throw Error("SSH output already exists"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
 } catch (e) { await rm(reservation, { recursive: true }); throw e; }
 return { destination, release: () => rm(reservation, { recursive: true }) };
}
export async function saveJob(path: string, job: unknown) {
 const temporary = join(dirname(path), `.pending-job-${randomUUID()}`);
 let published = false;
 try {
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(job) + "\n"); await file.sync(); } finally { await file.close(); }
  await link(temporary, path); published = true;
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
 } catch (e) { if (published) await rm(path); throw e; }
 finally { await rm(temporary, { force: true }); }
}
