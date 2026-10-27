import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { privateOperatorPath } from "./baseline.ts";

/** The credentials file's content is unusable. Carries no file content. */
export class InvalidNatsCredentials extends Error {
 constructor() { super("NATS credentials are invalid"); }
}
/** The issuing account and the exact JWT and seed blocks that were checked, re-serialised so the SDK cannot authenticate with anything else. */
export interface NatsCredentials { readonly account: string; readonly canonical: string }

const ClaimsSchema = z.object({ iss: z.string(), sub: z.string().regex(/^U[A-Z2-7]{55}$/), nats: z.object({ type: z.literal("user"), issuer_account: z.string().optional() }).passthrough() }).passthrough();
const invalid = (): never => { throw new InvalidNatsCredentials(); };

function parseNatsCredentials(text: string): NatsCredentials {
 try {
  const jwt = /-----BEGIN NATS USER JWT-----\s+([A-Za-z0-9_.-]+)\s+------END NATS USER JWT------/.exec(text)?.[1];
  if (jwt?.split(".").length !== 3) return invalid();
  const claims = ClaimsSchema.parse(JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")));
  const seed = /-----BEGIN USER NKEY SEED-----\s+(SU[A-Z2-7]{56})\s+------END USER NKEY SEED------/.exec(text)?.[1];
  if (!seed) return invalid();
  return { account: claims.nats.issuer_account ?? claims.iss,
   canonical: `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n` };
 } catch { return invalid(); }
}

/** Reads a private operator credentials file. Path and permission failures propagate unchanged; unusable content raises InvalidNatsCredentials. */
export async function readNatsCredentials(path: string): Promise<NatsCredentials> {
 const file = await open(await privateOperatorPath(path, true), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 let bytes: Buffer;
 try {
  const info = await file.stat();
  if (!info.isFile() || info.size > 65_536 || info.nlink !== 1) return invalid();
  bytes = await file.readFile();
 } finally { await file.close(); }
 return parseNatsCredentials(bytes.toString("utf8"));
}

/** Writes the checked blocks as transport.creds in a private directory; the SDK authenticates with this file only. */
export async function writeNatsCredentialsSnapshot(directory: string, credentials: NatsCredentials): Promise<string> {
 const path = join(directory, "transport.creds");
 await writeFile(path, credentials.canonical, { flag: "wx", mode: 0o600 });
 return path;
}

export const bindsNatsAccount = (credentials: NatsCredentials, account: string) => /^A[A-Z2-7]{55}$/.test(credentials.account) && credentials.account === account;
