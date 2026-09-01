import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "office-pool-finish-artifacts-")); roots.push(root);
  mkdirSync(join(root, "artifacts/screenshots"), { recursive: true }); mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "DESIGN.md"), `---\ntitle: Office Pool Reborn Design\ngenerated-from: final-source-dist-and-screenshots\n---\n\n# Office Pool Reborn Design\n\n## Visual direction\nCompact, table-first pool operations.\n\n## Palette\n- Navy: \`#002b5c\`\n- Blue: \`#135a99\`\n- Orange: \`#c75000\`\n- Paper: \`#ffffff\`\n\n## Typography\nArial and Verdana.\n\n## Layout\nCentered desktop canvas with fluid narrow screens.\n\n## Components\nMasthead, ribbon, tables, forms, and bet slip.\n\n## Responsive and accessibility\nVisible focus, reduced motion, table scrolling, and AA contrast.\n`);
  writeFileSync(join(root, "artifacts/detector.json"), "[]\n"); writeFileSync(join(root, "artifacts/detector.exit"), "0\n");
  writeFileSync(join(root, "artifacts/screenshots/final-odds-desktop.png"), "fixture screenshot");
  writeFileSync(join(root, "docs/finish-verdict.md"), `# Finish verdict\n\n## Detector findings\nNo detector findings.\n\n## Screenshot criteria\n- Density: compact table-first layout retained.\n- Overflow: tables scroll inside their containers.\n- Focus: visible focus token verified.\n- Exclusions: no cards, gradients, or shadows.\n`);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("finish artifact validator", () => {
  it("accepts complete final evidence and canonical design documentation", () => {
    const root = fixture();
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Finish artifacts verified.");
  });

  it("rejects a verdict without every screenshot criterion", () => {
    const root = fixture(); writeFileSync(join(root, "docs/finish-verdict.md"), "# Finish verdict\n\n## Detector findings\nNone.\n\n## Screenshot criteria\n- Density: checked.\n");
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("overflow");
  });

  it("requires the verdict to dispose Impeccable antipattern findings", () => {
    const root = fixture(); writeFileSync(join(root, "artifacts/detector.json"), '[{"antipattern":"overused-font"}]\n'); writeFileSync(join(root, "docs/finish-verdict.md"), "# Finish verdict\n\n## Detector findings\nNo detector findings.\n\n## Screenshot criteria\n- Density: checked.\n- Overflow: checked.\n- Focus: checked.\n- Exclusions: checked.\n");
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("overused-font");
  });
});
