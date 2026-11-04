import { defineConfig } from "@playwright/test";

// Which Chromium runs the specs: Playwright's own (`npx playwright install
// chromium`, as in CI) unless PLAYWRIGHT_CHROMIUM_EXECUTABLE names another
// binary – for machines with a Chromium of their own whose revision does not
// match this Playwright version, e.g.
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npx playwright test
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

// Specs import app modules (lib/document-server → sanitize-html, a CommonJS
// package that require()s the ES module htmlparser2). Under Playwright's
// synchronous loader hooks (module.registerHooks(), used where Node has it)
// that require() fails – "request for './Parser.js' is from a module not been
// linked" – while Playwright's asynchronous loader handles it. The test
// workers start after this file is read and inherit the variable; the main
// process registered its loader before, so specs import such modules inside
// the test (`await import(...)`), not at the top of the file.
process.env.PLAYWRIGHT_FORCE_ASYNC_LOADER ??= "1";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: {
    timeout: Number(process.env.TEST_EXPECT_TIMEOUT_MS || 5000),
  },
  use: {
    baseURL: process.env.TEST_BASE_URL || "http://127.0.0.1:3000",
    headless: true,
    // The tests read German texts; English is tested explicitly. API
    // requests (request fixture, page.request) do not take the locale, so
    // they state the language themselves.
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    screenshot: "only-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  reporter: "list",
});
