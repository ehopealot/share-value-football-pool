import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const contract = "THESIS: a private pool is operated from compact, auditable sports tables, never a generic dashboard. OWN-WORLD: navy and medium-blue bars, gray table fills, white fields, orange action controls, Arial/Verdana, square borders. STORY: members fund shares, confirm locked terms, and follow fair revealed results. FIRST VIEWPORT: centered mostly-fixed desktop canvas; navy masthead and blue navigation above a dense overview table with orange primary action; canvas becomes fluid on narrow screens. FORM: share-pool-operate-2007-v1. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md";
const root = process.cwd();
const files = [resolve(root, "index.html"), resolve(root, "dist/client/index.html")];

function verify(file) {
  if (!existsSync(file)) throw new Error(`${file} is required for direction-contract verification.`);
  const html = readFileSync(file, "utf8");
  const firstBodyChild = new RegExp(`<body\\b[^>]*>\\s*<!-- ${contract.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")} -->`);
  if (!firstBodyChild.test(html)) {
    throw new Error(`${file} does not retain the complete required direction contract as the first body child.`);
  }
}

for (const file of files) verify(file);
console.log("Direction contract verified.");
