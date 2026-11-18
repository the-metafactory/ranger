import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";
import { isOperatorPrivate, privateOperatorPath } from "./remote-test/baseline.ts";

/** Opens the key itself, never a path swapped in after the permission check: no symlink, one link, one read. */
export async function readGitHubAppKey(path: string): Promise<string> {
 const file = await open(await privateOperatorPath(path, true), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 let pem: string;
 try {
  const info = await file.stat();
  if (!info.isFile() || info.nlink !== 1 || !isOperatorPrivate(info)) {
   throw new Error("GitHub App key file must be operator-owned without group/world access");
  }
  pem = await file.readFile("utf8");
 } finally {
  await file.close();
 }
 createPrivateKey(pem);
 return pem;
}
