// Part 2 of 4 of the implement-lane e2e suite (implement-e2e.suite.ts), split
// so `bun test --parallel` runs the parts side by side (test/partition.ts).
import { selectPart } from "./partition.ts";

selectPart(1, 4);
await import("./implement-e2e.suite.ts");
