import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { verifyDesignFile } from "./verify-design-md.mjs";

const root = resolve(process.env.FINISH_REVIEW_ROOT ?? process.cwd());
const requiredCriteria = ["density", "overflow", "focus", "exclusions"];
const requiredHeading = (document, heading) => new RegExp(`^## ${heading}$`, "m").test(document);
const readRequired = (relative) => {
  const file = resolve(root, relative);
  if (!existsSync(file)) throw new Error(`${relative} is required.`);
  return readFileSync(file, "utf8");
};
const detectorFindingIds = (value) => {
  const findings = Array.isArray(value) ? value : Array.isArray(value?.findings) ? value.findings : [];
  return findings.map((finding) => String(finding.id ?? finding.ruleId ?? finding.rule ?? finding.antipattern ?? "")).filter(Boolean);
};

export function verifyFinishArtifacts() {
  verifyDesignFile(root);
  const detector = JSON.parse(readRequired("artifacts/detector.json"));
  const detectorExit = readRequired("artifacts/detector.exit").trim();
  if (!/^(0|2)$/.test(detectorExit)) throw new Error("artifacts/detector.exit must record detector status 0 or 2.");
  const screenshots = resolve(root, "artifacts/screenshots");
  if (!existsSync(screenshots)) throw new Error("artifacts/screenshots is required.");
  const finalShots = readdirSync(screenshots).filter((name) => name.startsWith("final-") && name.endsWith(".png"));
  if (!finalShots.length) throw new Error("At least one final screenshot is required.");
  for (const name of finalShots) if (statSync(resolve(screenshots, name)).size === 0) throw new Error(`Final screenshot is empty: ${name}.`);
  const verdict = readRequired("docs/finish-verdict.md");
  if (!requiredHeading(verdict, "Detector findings")) throw new Error("Finish verdict must include a Detector findings section.");
  if (!requiredHeading(verdict, "Screenshot criteria")) throw new Error("Finish verdict must include a Screenshot criteria section.");
  const lower = verdict.toLowerCase();
  for (const criterion of requiredCriteria) if (!lower.includes(criterion)) throw new Error(`Finish verdict must dispose screenshot criterion: ${criterion}.`);
  for (const id of detectorFindingIds(detector)) if (!verdict.includes(id)) throw new Error(`Finish verdict must dispose detector finding: ${id}.`);
}

try {
  verifyFinishArtifacts();
  console.log("Finish artifacts verified.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
