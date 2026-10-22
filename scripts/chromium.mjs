// Which Chromium the quality budgets and the visual tests use: the binary in
// QUALITY_CHROMIUM, else /opt/pw-browsers/chromium when it exists, else the
// one `npx playwright install chromium` put in Playwright's cache.
//
//   node scripts/chromium.mjs --check   exit code 0 when one starts
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function chromiumCandidates() {
  if (process.env.QUALITY_CHROMIUM) return [process.env.QUALITY_CHROMIUM];
  return [...(existsSync("/opt/pw-browsers/chromium") ? ["/opt/pw-browsers/chromium"] : []), undefined];
}

// The first candidate that starts, or the reason none did.
export async function launchChromium() {
  const { chromium } = await import("@playwright/test");
  let last;
  for (const executablePath of chromiumCandidates()) {
    try {
      return { browser: await chromium.launch({ executablePath, headless: true }), executablePath };
    } catch (error) {
      last = error;
    }
  }
  return { error: String(last?.message || last).split("\n")[0] };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href && process.argv.includes("--check")) {
  const { browser, executablePath, error } = await launchChromium();
  if (browser) {
    await browser.close();
    console.log(`chromium: ${executablePath || "Playwright's own"}`);
  } else console.log(`chromium: none available (${error})`);
  process.exit(browser ? 0 : 1);
}
