import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DESIGN_SECTIONS = ["Visual direction", "Palette", "Typography", "Layout", "Components", "Responsive and accessibility"];
export const DESIGN_TOKENS = ["#002b5c", "#135a99", "#c75000", "#ffffff"];

export function verifyDesignMarkdown(markdown) {
  if (!markdown.startsWith("---\ntitle: Office Pool Reborn Design\ngenerated-from: final-source-dist-and-screenshots\n---\n")) throw new Error("DESIGN.md must begin with the canonical generated-design frontmatter.");
  let previous = -1;
  for (const section of DESIGN_SECTIONS) {
    const index = markdown.indexOf(`## ${section}`);
    if (index < 0) throw new Error(`DESIGN.md is missing required section: ${section}.`);
    if (index <= previous) throw new Error(`DESIGN.md sections must use canonical order; ${section} is out of order.`);
    previous = index;
  }
  for (const color of DESIGN_TOKENS) if (!markdown.toLowerCase().includes(color)) throw new Error(`DESIGN.md must record CSS token ${color}.`);
}

export function verifyDesignFile(root = process.cwd()) {
  const file = resolve(root, "DESIGN.md");
  if (!existsSync(file)) throw new Error("DESIGN.md is required.");
  verifyDesignMarkdown(readFileSync(file, "utf8"));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  verifyDesignFile(process.env.FINISH_REVIEW_ROOT ?? process.cwd());
  console.log("DESIGN.md verified.");
}
