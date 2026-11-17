import { createPrivateKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isOperatorPrivate, privateOperatorPath } from "./remote-test/baseline.ts";

export async function readGitHubAppKey(path: string): Promise<string> {
 const file = await privateOperatorPath(path, true);
 if (!isOperatorPrivate(await stat(file))) throw new Error("GitHub App key file must be operator-owned without group/world access");
 const pem = await readFile(file, "utf8");
 createPrivateKey(pem);
 return pem;
}
