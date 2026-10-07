import type { CiVerdict } from "./forge.ts";

/** The merge gate consumes a neutral verdict already classified by the adapter. */
export function classifyCi(ci: CiVerdict):
 | { status: "pass"; runId: number }
 | { status: "fail" | "pending"; reason: string } {
 if (ci.state === "green") return { status: "pass", runId: ci.runId };
 return { status: ci.state === "red" ? "fail" : "pending", reason: ci.reason };
}
