import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const phase = process.argv.find((argument) => argument.startsWith("--phase="))?.split("=")[1];
if (phase !== "initial" && phase !== "final") throw new Error("Use --phase=initial or --phase=final.");

const baseUrl = process.env.SCREENSHOT_BASE_URL ?? "http://127.0.0.1:8787";
const routes = ["/p/demo/odds", "/p/demo/confirmation", "/p/demo/standings", "/p/demo/activity", "/p/demo/error", "/p/demo/closed"];
const viewports = [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 844 }];

await mkdir("artifacts/screenshots", { recursive: true });
const browser = await chromium.launch();
try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    for (const route of routes) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
      const name = route.split("/").at(-1);
      await page.screenshot({ path: `artifacts/screenshots/${phase}-${name}-${viewport.name}.png`, fullPage: true });
    }
  }
} finally {
  await browser.close();
}
