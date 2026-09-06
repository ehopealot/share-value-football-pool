import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { detectorFindingIds } from "./detector-findings.mjs";
import { screenshotRoutes, screenshotViewports } from "./screenshot-plan.mjs";
import { verifyDesignFile } from "./verify-design-md.mjs";

const root = resolve(process.env.FINISH_REVIEW_ROOT ?? process.cwd());
const requiredCriteria = ["density", "overflow", "focus", "exclusions"];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DECODED_PNG_BYTES = 256 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
const pngCrc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};
const pngPasses = (width, height, interlace) => {
  if (interlace === 0) return [[width, height]];
  return [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]].map(([x, y, dx, dy]) => [
    width > x ? Math.ceil((width - x) / dx) : 0,
    height > y ? Math.ceil((height - y) / dy) : 0,
  ]);
};
const isStructuredPng = (image) => {
  if (image.length < pngSignature.length || !image.subarray(0, pngSignature.length).equals(pngSignature)) return false;
  let offset = pngSignature.length; let first = true; let header; let sawPalette = false; let sawImageData = false; let imageDataEnded = false;
  const compressed = [];
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    const dataStart = offset + 8; const dataEnd = dataStart + length; const end = dataEnd + 4;
    if (!Number.isSafeInteger(end) || end > image.length) return false;
    const type = image.toString("ascii", offset + 4, dataStart);
    if (pngCrc32(image.subarray(offset + 4, dataEnd)) !== image.readUInt32BE(dataEnd)) return false;
    if (first) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = image.readUInt32BE(dataStart); const height = image.readUInt32BE(dataStart + 4);
      const bitDepth = image[dataStart + 8]; const colorType = image[dataStart + 9];
      const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      const compression = image[dataStart + 10]; const filter = image[dataStart + 11]; const interlace = image[dataStart + 12];
      if (width === 0 || height === 0 || !validDepths[colorType]?.includes(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) return false;
      header = { width, height, bitDepth, colorType, interlace }; first = false;
    } else if (type === "IHDR") return false;
    if (type === "PLTE") {
      if (!header || sawPalette || sawImageData || header.colorType === 0 || header.colorType === 4 || length < 3 || length > 768 || length % 3 !== 0) return false;
      if (header.colorType === 3 && length / 3 > 2 ** header.bitDepth) return false;
      sawPalette = true;
    }
    if (type === "IDAT") {
      if (imageDataEnded || (header?.colorType === 3 && !sawPalette)) return false;
      sawImageData = true; compressed.push(image.subarray(dataStart, dataEnd));
    } else if (sawImageData && type !== "IEND") imageDataEnded = true;
    if (type === "IEND") {
      if (length !== 0 || end !== image.length || !header || !sawImageData) return false;
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
      const passes = pngPasses(header.width, header.height, header.interlace);
      let expectedBytes = 0;
      for (const [passWidth, passHeight] of passes) if (passWidth && passHeight) expectedBytes += passHeight * (1 + Math.ceil(passWidth * channels * header.bitDepth / 8));
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_DECODED_PNG_BYTES) return false;
      try {
        const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
        if (decoded.length !== expectedBytes) return false;
        let decodedOffset = 0;
        for (const [passWidth, passHeight] of passes) {
          if (!passWidth || !passHeight) continue;
          const rowBytes = Math.ceil(passWidth * channels * header.bitDepth / 8);
          for (let row = 0; row < passHeight; row++) {
            if (decoded[decodedOffset] > 4) return false;
            decodedOffset += 1 + rowBytes;
          }
        }
        return decodedOffset === decoded.length;
      } catch { return false; }
    }
    offset = end;
  }
  return false;
};
const requiredHeading = (document, heading) => new RegExp(`^## ${heading}$`, "m").test(document);
const readRequired = (relative) => {
  const file = resolve(root, relative);
  if (!existsSync(file)) throw new Error(`${relative} is required.`);
  return readFileSync(file, "utf8");
};
const sectionUnderHeading = (document, heading) => {
  const lines = document.split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) return undefined;
  const endOffset = lines.slice(start + 1).findIndex((line) => /^#{1,6}\s/.test(line));
  return lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset).join("\n");
};

export function verifyFinishArtifacts() {
  verifyDesignFile(root);
  const detector = JSON.parse(readRequired("artifacts/detector.json"));
  const detectorExit = readRequired("artifacts/detector.exit").trim();
  if (!/^(0|2)$/.test(detectorExit)) throw new Error("artifacts/detector.exit must record detector status 0 or 2.");
  const screenshots = resolve(root, "artifacts/screenshots");
  if (!existsSync(screenshots)) throw new Error("artifacts/screenshots is required.");
  const finalShots = screenshotRoutes("finish-review", "season-id", "Finish Review Pool", "Accessibility 2026").flatMap((route) => screenshotViewports.map((viewport) => `final-${route.name}-${viewport.name}.png`));
  for (const name of finalShots) {
    const file = resolve(screenshots, name);
    if (!existsSync(file)) throw new Error(`Final screenshot is required: ${name}.`);
    const image = readFileSync(file);
    if (!isStructuredPng(image)) throw new Error(`Final screenshot is not a valid PNG: ${name}.`);
  }
  const verdict = readRequired("docs/finish-verdict.md");
  if (!requiredHeading(verdict, "Detector findings")) throw new Error("Finish verdict must include a Detector findings section.");
  if (!requiredHeading(verdict, "Screenshot criteria")) throw new Error("Finish verdict must include a Screenshot criteria section.");
  const detectorFindings = sectionUnderHeading(verdict, "Detector findings") ?? "";
  const screenshotCriteria = sectionUnderHeading(verdict, "Screenshot criteria")?.toLowerCase() ?? "";
  for (const criterion of requiredCriteria) if (!screenshotCriteria.includes(criterion)) throw new Error(`Finish verdict Screenshot criteria section must mention: ${criterion}.`);
  for (const id of detectorFindingIds(detector, "artifacts/detector.json")) if (!detectorFindings.includes(id)) throw new Error(`Finish verdict Detector findings section must mention: ${id}.`);
}

try {
  verifyFinishArtifacts();
  console.log("Finish artifacts verified.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
