import { defineConfig } from "@playwright/test";
import { chromiumCandidates } from "./scripts/chromium.mjs";

// Visual regression tests (tests/visual): screenshots of key screens of the
// production build, compared with the committed baselines in
// tests/visual/__screenshots__. Not part of `npm test`:
//
//   npm run build && npm run test:visual          compare
//   npm run build && npm run test:visual:update   write new baselines
//
// Screens differ slightly between machines (fonts, rendering), so the
// baselines belong to one environment – the one the CI job runs in.
// The same browser as npm run quality (scripts/chromium.mjs).
const chromium = chromiumCandidates()[0];

export default defineConfig({
  testDir: "./tests/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  outputDir: "./test-results/visual",
  globalSetup: "./tests/visual/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // A little room for anti-aliasing, none for a changed layout.
      maxDiffPixelRatio: 0.005,
      threshold: 0.2,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: {
    headless: true,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    colorScheme: "light",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 800 },
    launchOptions: chromium ? { executablePath: chromium } : {},
  },
  reporter: "list",
});
