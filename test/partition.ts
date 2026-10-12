import { test as bunTest } from "bun:test";

/**
 * Split one long suite across several test files, so `bun test --parallel`
 * runs the parts side by side. A part file calls `selectPart` and then
 * imports the suite; the suite registers its tests through `test` from here,
 * which keeps every `of`-th test, starting at `part`. Registration order is
 * the module's own, so the parts together register each test exactly once.
 */
let part = 0;
let of = 1;
let seen = 0;

export function selectPart(index: number, count: number): void {
 part = index;
 of = count;
 seen = 0;
}

const mine = (): boolean => seen++ % of === part;

type BunTest = typeof bunTest;

export const test = Object.assign(
 (...args: Parameters<BunTest>) => {
  if (mine()) bunTest(...args);
 },
 {
  skipIf:
   (condition: boolean) =>
   (...args: Parameters<BunTest>) => {
    if (mine()) bunTest.skipIf(condition)(...args);
   },
  /** Each row is one test, and is dealt to a part like any other. */
  each:
   <T>(rows: readonly T[]) =>
   (name: string, fn: (row: T) => unknown, timeout?: number) => {
    for (const row of rows) {
     if (mine()) bunTest.each([row] as T[])(name, fn as never, timeout);
    }
   },
 },
);
