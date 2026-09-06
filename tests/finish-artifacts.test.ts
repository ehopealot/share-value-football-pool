import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const finalShotNames = ["overview", "odds", "teaser", "my-wagers", "standings", "activity", "rules", "orders", "history"].flatMap((route) => ["desktop", "mobile"].map((viewport) => `final-${route}-${viewport}.png`));
const minimalPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const indexedPngWithoutPalette = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64");
const pngWithEmptyIdat = Buffer.concat([
  minimalPng.subarray(0, 33),
  Buffer.from("000000004944415435af061e", "hex"),
  minimalPng.subarray(33),
]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
const pngCrc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Buffer) => {
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0); payload.copy(chunk, 4); chunk.writeUInt32BE(pngCrc32(payload), 8 + data.length);
  return chunk;
};
const structuredButUndecodablePng = Buffer.concat([
  minimalPng.subarray(0, 33),
  pngChunk("IDAT", Buffer.from([0x00])),
  minimalPng.subarray(-12),
]);
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "office-pool-finish-artifacts-")); roots.push(root);
  mkdirSync(join(root, "artifacts/screenshots"), { recursive: true }); mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "DESIGN.md"), `---\ntitle: Office Pool Reborn Design\ngenerated-from: final-source-dist-and-screenshots\n---\n\n# Office Pool Reborn Design\n\n## Visual direction\nCompact, table-first pool operations.\n\n## Palette\n- Navy: \`#002b5c\`\n- Blue: \`#135a99\`\n- Orange: \`#c75000\`\n- Paper: \`#ffffff\`\n\n## Typography\nArial and Verdana.\n\n## Layout\nCentered desktop canvas with fluid narrow screens.\n\n## Components\nMasthead, ribbon, tables, forms, and bet slip.\n\n## Responsive and accessibility\nVisible focus, reduced motion, table scrolling, and AA contrast.\n`);
  writeFileSync(join(root, "artifacts/detector.json"), "[]\n"); writeFileSync(join(root, "artifacts/detector.exit"), "0\n");
  for (const name of finalShotNames) writeFileSync(join(root, "artifacts/screenshots", name), minimalPng);
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

  it("decodes detector JSON after a multibyte identifier is split across stdout chunks", async () => {
    const finishModule = await import(pathToFileURL(resolve(import.meta.dirname, "../scripts/run-finish-review.mjs")).href);
    const runFinishCommand = (finishModule as { runFinishCommand: (command: string, args: string[], options: Record<string, unknown>) => Promise<{ status: number; stdout: string }> }).runFinishCommand;
    const detectorOutput = '[{"id":"détecteur"}]\n';
    const bytes = Buffer.from(detectorOutput);
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    const source = `const bytes=Buffer.from(${JSON.stringify(bytes.toString("base64"))},"base64");process.stdout.write(bytes.subarray(0,${split}));setTimeout(()=>process.stdout.write(bytes.subarray(${split})),20);`;
    const result = await runFinishCommand(process.execPath, ["-e", source], { captureStdout: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(detectorOutput);
    expect(JSON.parse(result.stdout)).toEqual([{ id: "détecteur" }]);
  });

  it("accepts a valid PNG with an empty IDAT adjacent to non-empty image data", () => {
    const root = fixture();
    writeFileSync(join(root, "artifacts/screenshots/final-odds-desktop.png"), pngWithEmptyIdat);
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Finish artifacts verified.");
  });

  it("rejects indexed-color PNG data without its required palette", () => {
    const root = fixture();
    writeFileSync(join(root, "artifacts/screenshots/final-odds-desktop.png"), indexedPngWithoutPalette);
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Final screenshot is not a valid PNG: final-odds-desktop.png");
  });

  it("rejects a corrupt expected screenshot", () => {
    const root = fixture(); writeFileSync(join(root, "artifacts/screenshots/final-odds-desktop.png"), "not a PNG");
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Final screenshot is not a valid PNG: final-odds-desktop.png");
  });

  it("rejects a structured PNG with valid chunk CRCs whose image data cannot decode", () => {
    const root = fixture();
    writeFileSync(join(root, "artifacts/screenshots/final-odds-desktop.png"), structuredButUndecodablePng);
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Final screenshot is not a valid PNG: final-odds-desktop.png");
  });

  it("rejects a signature-only truncated PNG", () => {
    const root = fixture();
    writeFileSync(join(root, "artifacts/screenshots/final-odds-desktop.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Final screenshot is not a valid PNG: final-odds-desktop.png");
  });

  it("rejects design section names embedded in non-heading text", () => {
    const root = fixture();
    const designPath = join(root, "DESIGN.md");
    writeFileSync(designPath, readFileSync(designPath, "utf8").replace("## Palette", "not a heading: ## Palette"));
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DESIGN.md is missing required section: Palette.");
  });

  it("rejects a missing expected screenshot", () => {
    const root = fixture(); rmSync(join(root, "artifacts/screenshots/final-history-mobile.png"));
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Final screenshot is required: final-history-mobile.png");
  });

  it("rejects a verdict without every screenshot criterion", () => {
    const root = fixture(); writeFileSync(join(root, "docs/finish-verdict.md"), "# Finish verdict\n\n## Detector findings\nNone.\n\n## Screenshot criteria\n- Density: checked.\n");
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must mention: overflow");
  });

  it("requires screenshot criteria inside their dedicated verdict section", () => {
    const root = fixture(); writeFileSync(join(root, "docs/finish-verdict.md"), "# Finish verdict\n\n## Detector findings\nOverflow, focus, and exclusions appear here only.\n\n## Screenshot criteria\n- Density: checked.\n\n## Conclusion\nDone.\n");
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must mention: overflow");
  });

  it("rejects detector JSON with no recognized findings container", () => {
    for (const malformed of ["{}\n", "null\n", "[\"not-a-finding\"]\n"]) {
      const root = fixture(); writeFileSync(join(root, "artifacts/detector.json"), malformed);
      const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
      expect(result.status, malformed).not.toBe(0);
      expect(result.stderr, malformed).toContain("array of finding objects");
    }
  });

  it("rejects detector findings without a nonblank supported identifier", () => {
    for (const malformed of ["[{}]\n", '[{"id":"  "}]\n']) {
      const root = fixture(); writeFileSync(join(root, "artifacts/detector.json"), malformed);
      const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
      expect(result.status, malformed).not.toBe(0);
      expect(result.stderr, malformed).toContain("nonblank id, ruleId, rule, or antipattern");
    }
  });

  it("requires detector identifiers to be mentioned inside their dedicated verdict section", () => {
    const root = fixture();
    writeFileSync(join(root, "artifacts/detector.json"), '[{"id":"outside-only"}]\n');
    writeFileSync(join(root, "docs/finish-verdict.md"), "# Finish verdict\n\n## Detector findings\nNo detector findings.\n\n## Screenshot criteria\n- Density: checked.\n- Overflow: checked.\n- Focus: checked.\n- Exclusions: checked.\n\n## Conclusion\noutside-only\n");
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must mention: outside-only");
  });

  it("requires the verdict to mention Impeccable antipattern findings", () => {
    const root = fixture(); writeFileSync(join(root, "artifacts/detector.json"), '[{"antipattern":"overused-font"}]\n'); writeFileSync(join(root, "docs/finish-verdict.md"), "# Finish verdict\n\n## Detector findings\nNo detector findings.\n\n## Screenshot criteria\n- Density: checked.\n- Overflow: checked.\n- Focus: checked.\n- Exclusions: checked.\n");
    const result = spawnSync(process.execPath, ["scripts/verify-finish-artifacts.mjs"], { cwd: process.cwd(), env: { ...process.env, FINISH_REVIEW_ROOT: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must mention: overused-font");
  });
});
