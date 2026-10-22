import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export const STATE_FILE = join(process.cwd(), "test-results", "visual-state.json");
export const STORAGE_FILE = join(process.cwd(), "test-results", "visual-storage.json");

export type VisualState = { origin: string; workspaceId: string; documentId: string; databaseId: string };
export const visualState = (): VisualState => JSON.parse(readFileSync(STATE_FILE, "utf8"));

// Every screen sees the same moment: Thursday, 15 October 2026, 09:30 in
// Berlin. Timers keep running, only the date is fixed.
export const FIXED_TIME = new Date("2026-10-15T09:30:00+02:00");

// Opens an address of the app and waits until it has settled: the page tree
// is there, nothing loads any more, the web fonts are ready.
export async function openApp(page: Page, hash = "") {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(`${visualState().origin}/${hash}`);
  await page.locator(".sidebar").first().waitFor({ state: "attached" });
  await settle(page);
}
export async function settle(page: Page) {
  // Documents keep a live connection open, so "idle" may never come.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  // Two frames, so layout after the last data has been painted.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
