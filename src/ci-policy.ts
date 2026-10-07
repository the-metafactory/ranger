import type { CiVerdict } from "./forge.ts";

/** Lanes consume a verdict; only the adapter interprets forge CI records. */
export function classifyCi(ci: CiVerdict):
 | { status: "pass"; runId: number }
 | { status: "fail" | "pending"; reason: string } {
 if (ci.state === "green") return { status: "pass", runId: ci.runId };
 return { status: ci.state === "red" ? "fail" : "pending", reason: ci.reason };
}
