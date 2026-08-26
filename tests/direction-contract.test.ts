import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const verifier = resolve(root, "scripts/verify-direction-contract.mjs");
const sourceHtml = readFileSync(resolve(root, "index.html"), "utf8");
const contract = sourceHtml.match(/<!-- ([\s\S]*?) -->/)?.[1];
if (!contract) throw new Error("The source root contract is missing.");

function withFixture(html: string, includeDist: boolean, run: (directory: string) => void) {
  const directory = mkdtempSync(resolve(tmpdir(), "share-pool-contract-"));
  try {
    writeFileSync(resolve(directory, "index.html"), html);
    if (includeDist) {
      const clientDirectory = resolve(directory, "dist/client");
      mkdirSync(clientDirectory, { recursive: true });
      writeFileSync(resolve(clientDirectory, "index.html"), html);
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verify(directory: string) {
  return execFileSync("node", [verifier], { cwd: directory, encoding: "utf8", stdio: "pipe" });
}

describe("literal direction contract", () => {
  it("accepts the complete approved comment as the first body child in temporary source and build fixtures", () => {
    withFixture(sourceHtml, true, (directory) => {
      expect(verify(directory)).toContain("Direction contract verified.");
    });
  });

  it("rejects an absent build output", () => {
    withFixture(sourceHtml, false, (directory) => expect(() => verify(directory)).toThrow());
  });

  it("rejects a truncated contract", () => {
    withFixture(sourceHtml.replace(contract, contract.slice(0, -20)), true, (directory) => expect(() => verify(directory)).toThrow());
  });

  it("rejects content before the body contract", () => {
    withFixture(sourceHtml.replace("<body>\n    <!--", "<body>\n    <div>wrong first child</div>\n    <!--"), true, (directory) => expect(() => verify(directory)).toThrow());
  });
});
