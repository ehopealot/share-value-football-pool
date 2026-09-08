import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/AdminOrdersPage.tsx"), "utf8");

describe("share order history toggle", () => {
  it("defaults to grouped members and opts into individual orders", () => {
    expect(source).toContain("const [groupByMember, setGroupByMember] = useState(true);");
    expect(source).toContain('checked={!groupByMember} onChange={event => setGroupByMember(!event.target.checked)} /> Show individual orders');
    expect(source).toContain("{groupByMember ? <table>");
    expect(source).not.toContain("/> Group by member");
  });
});
