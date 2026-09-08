import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/AdminOrdersPage.tsx"), "utf8");

describe("commissioner share-order $1 lock", () => {
  it("offers an unchecked checkbox and binds the choice through quote requests", () => {
    expect(source).toContain("Lock price at $1 per share");
    expect(source).toMatch(/lockPriceAtOneDollar:\s*false/);
    expect(source).toContain("checked={editor?.lockPriceAtOneDollar ?? false}");
    expect(source).toContain("lockPriceAtOneDollar: request.lockPriceAtOneDollar");
  });
});
