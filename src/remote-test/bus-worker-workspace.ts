import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const BUS_WORKER_DIR = ".bus-worker";
const OWNER_FILE = "owner.json";
const OwnerSchema = z.object({ ledgerId: z.string().uuid() }).strict();

export async function writeBusWorkerOwner(directory: string, ledgerId: string): Promise<void> {
 const owner = OwnerSchema.parse({ ledgerId });
 await writeFile(join(directory, OWNER_FILE), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
}

export async function readBusWorkerOwner(directory: string) {
 return OwnerSchema.parse(JSON.parse(await readFile(join(directory, OWNER_FILE), "utf8")));
}
