import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/OverviewPage.tsx"), "utf8");

describe("Overview page", () => {
  it("uses the three-decimal current share-value formatter for the share price", () => {
    expect(source).toContain('import { formatCurrentShareValue } from "../share-value";');
    expect(source).toContain('const price = season && BigInt(season.floatMicros) !== 0n ? formatCurrentShareValue(season.floatMicros, season.notionalValueMicros) : "$1.000";');
  });
});
