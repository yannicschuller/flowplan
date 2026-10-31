// Quality budgets for the production build: accessibility (axe-core), focus
// inside aria-hidden, horizontal overflow, JavaScript sent per page and the
// largest contentful paint. The sign-in page and pages of a seeded workspace
// are opened at 1280 and 390 px wide in Chromium; the script fails when one
// of them breaks a rule or a budget.
//
//   npm run build && npm run quality
//
// It starts the standalone server with an empty data directory and signs up
// an account with example content through the API
// (scripts/production-server.mjs). The browser is Playwright's Chromium;
// QUALITY_CHROMIUM names another binary, otherwise /opt/pw-browsers/chromium
// is used when it exists. With QUALITY_OPTIONAL=1 a missing browser skips
// the check instead of failing it (the own CI runner downloads nothing).
import { createRequire } from "node:module";
import { request as playwrightRequest } from "@playwright/test";
import { launchChromium } from "./chromium.mjs";
import { hasBuild, seedAccount, startProductionServer } from "./production-server.mjs";

// ---------------------------------------------------------------- settings
// Measured 2026-10-22 (gzip): sign-in and sign-up 375.3 KB, a document
// 2017.5 KB, a database 1534.9 KB – the workspace loads the editor and the
// database views with its first page. Settings and administration (landing
// pages and a section, 2026-10-22): 1573.9 KB; the start page (2026-10-25)
// 1652.4 KB, its editor (about 10 KB) loads only when customizing. LCP on localhost: sign-in 140–280 ms,
// database 250–500 ms, document 1.0–1.7 s. The JS budgets are about 10 %
// above the measured values. Since the French catalogue left the shared
// JavaScript (2026-10-31, lib/i18n-catalogs.ts) sign-in and registration
// measure 262.1 KB, the signed-in pages about 170 KB less than before.
const PAGES = [
  { path: "/login", jsKb: 290 },
  { path: "/register", jsKb: 290 },
  { path: (ids) => `/#page=${ids.documentId}`, name: "document", signedIn: true, jsKb: 2220 },
  { path: (ids) => `/#page=${ids.databaseId}`, name: "database", signedIn: true, jsKb: 1690 },
  // The landing pages of the settings and the administration (tiles), and a
  // settings section on a phone (components/settings/shell.tsx).
  // The start page with its widgets; customizing loads on demand
  // (components/home/home-editor.tsx).
  { path: "/#home", name: "home", signedIn: true, jsKb: 1730, ready: ".home-grid" },
  { path: "/#settings", name: "settings", signedIn: true, jsKb: 1730, ready: ".settings-tile" },
  { path: "/#settings/account", name: "settings section", signedIn: true, jsKb: 1730, ready: ".settings-detail .setting-group" },
  { path: "/#admin", name: "administration", signedIn: true, jsKb: 1730, ready: ".live-strip .kpi-grid:not(.placeholder)" },
  // The live dashboard with every chart (components/settings/admin/monitoring.tsx).
  { path: "/#admin/monitoring", name: "monitoring", signedIn: true, jsKb: 1730, ready: ".mon-health" },
  // The push relay's state (components/settings/admin/push.tsx).
  { path: "/#admin/push", name: "push status", signedIn: true, jsKb: 1730, ready: "#relay" },
];
const BUDGET = { jsKb: 290, lcpMs: 2500 };
const LOCALE = "de-DE";
// --------------------------------------------------------------------------

const VIEWPORTS = [
  { name: "1280", viewport: { width: 1280, height: 800 } },
  { name: "390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];
const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");
// WCAG 2.x A/AA plus axe's best practices; only serious and critical
// findings fail the check (color-contrast is one of them).
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function launch() {
  const { browser, error } = await launchChromium();
  if (browser) return browser;
  const message = `quality: no Chromium available (${error}). Install it with "npx playwright install chromium" or set QUALITY_CHROMIUM.`;
  if (process.env.QUALITY_OPTIONAL === "1") {
    console.log(`${message}\nquality: skipped (QUALITY_OPTIONAL=1).`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

async function checkPage(browser, base, path, vp, options = {}) {
  const context = await browser.newContext({
    viewport: vp.viewport,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    deviceScaleFactor: 1,
    locale: options.locale || LOCALE,
    // axe is injected as an inline script; a strict CSP would block it.
    bypassCSP: true,
    // Reveal and scroll animations would be caught half-way (text at 30 %
    // opacity); with reduced motion the page shows its settled state.
    reducedMotion: "reduce",
    storageState: options.storageState,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__qualityLcp = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__qualityLcp = Math.max(window.__qualityLcp, entry.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
  });
  const sizes = [];
  page.on("requestfinished", (request) => {
    if (request.resourceType() === "script") sizes.push(request.sizes().then((s) => s.responseBodySize).catch(() => 0));
  });
  const response = await page.goto(base + path, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  if (options.ready) await options.ready(page);
  // Paint once more before reading LCP.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const lcp = await page.evaluate(() => window.__qualityLcp);
  const jsBytes = (await Promise.all(sizes)).reduce((a, b) => a + b, 0);

  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    if (scrollWidth <= width) return null;
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.classList.length ? "." + [...el.classList].slice(0, 3).join(".") : ""}`;
    const offenders = [...document.body.querySelectorAll("*")]
      .filter((el) => el.getBoundingClientRect().right > width + 1 && el.getBoundingClientRect().width > 0)
      .slice(0, 5)
      .map(describe);
    return { width, scrollWidth, offenders };
  });

  const hiddenFocus = await page.evaluate(() => {
    const focusable =
      'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"],audio[controls],video[controls]';
    const describe = (el) => el.outerHTML.slice(0, 120);
    const out = [];
    for (const root of document.querySelectorAll('[aria-hidden="true"]'))
      for (const el of [root, ...root.querySelectorAll(focusable)]) {
        if (!el.matches(focusable) || el.closest("[inert]") || el.disabled) continue;
        const tabindex = el.getAttribute("tabindex");
        if (tabindex !== null && Number(tabindex) < 0) continue;
        if (el.type === "hidden" || !el.checkVisibility({ visibilityProperty: true })) continue;
        out.push(describe(el));
      }
    return [...new Set(out)];
  });

  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async (tags) => {
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")}${n.failureSummary ? " – " + n.failureSummary.split("\n").slice(1, 2).join("").trim() : ""}`),
        count: v.nodes.length,
      }));
  }, AXE_TAGS);

  await context.close();
  return { status: response?.status() ?? 0, jsKb: jsBytes / 1024, lcp, overflow, hiddenFocus, violations };
}

function report(rows, budget) {
  const failures = [];
  console.log(`\n${"page".padEnd(34)} ${"width".padStart(5)} ${"JS KB".padStart(7)} ${"LCP ms".padStart(7)}  axe  aria-hidden  overflow`);
  for (const { path, vp, r, jsBudget } of rows) {
    const limit = jsBudget ?? budget.jsKb;
    console.log(
      `${path.padEnd(34)} ${vp.name.padStart(5)} ${r.jsKb.toFixed(1).padStart(7)} ${Math.round(r.lcp).toString().padStart(7)}  ${String(r.violations.length).padStart(3)}  ${String(r.hiddenFocus.length).padStart(11)}  ${r.overflow ? r.overflow.scrollWidth + "px" : "–"}`,
    );
    const where = `${path} @ ${vp.name}px`;
    if (r.status >= 400) failures.push(`${where}: HTTP ${r.status}`);
    if (r.jsKb > limit) failures.push(`${where}: ${r.jsKb.toFixed(1)} KB JavaScript (gzip), budget ${limit} KB`);
    if (!(r.lcp > 0)) failures.push(`${where}: no largest-contentful-paint entry`);
    else if (r.lcp > budget.lcpMs) failures.push(`${where}: LCP ${Math.round(r.lcp)} ms, budget ${budget.lcpMs} ms`);
    if (r.overflow) failures.push(`${where}: page is ${r.overflow.scrollWidth}px wide in a ${r.overflow.width}px viewport (${r.overflow.offenders.join(", ")})`);
    for (const el of r.hiddenFocus) failures.push(`${where}: focusable inside aria-hidden: ${el}`);
    for (const v of r.violations) failures.push(`${where}: axe ${v.impact} ${v.id} (${v.count}×) – ${v.help}\n      ${v.nodes.join("\n      ")}`);
  }
  if (failures.length) {
    console.error(`\nquality: ${failures.length} problem(s)\n  - ${failures.join("\n  - ")}`);
    return false;
  }
  console.log(`\nquality: all ${rows.length} checks within budget (JavaScript within each page's budget, LCP ≤ ${budget.lcpMs} ms, no serious axe findings).`);
  return true;
}

async function main() {
  if (!hasBuild()) {
    console.error("quality: no production build – run `npm run build` first.");
    process.exit(1);
  }
  const browser = await launch();
  const server = await startProductionServer();
  const rows = [];
  try {
    const api = await playwrightRequest.newContext({ baseURL: server.origin, extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" } });
    const ids = await seedAccount(api, server.origin);
    const storageState = await api.storageState();
    await api.dispose();
    for (const entry of PAGES) {
      const path = typeof entry.path === "function" ? entry.path(ids) : entry.path;
      const options = {
        storageState: entry.signedIn ? storageState : undefined,
        // The workspace renders on the client: wait for the page tree.
        ready: entry.signedIn
          ? async (page) => {
              await page.locator(".sidebar").first().waitFor({ state: "attached", timeout: 30000 });
              if (entry.ready) await page.locator(entry.ready).first().waitFor({ state: "visible", timeout: 30000 });
            }
          : undefined,
      };
      for (const vp of VIEWPORTS) {
        // A first visit warms the server (rendering, file cache); the
        // numbers come from the second.
        if (vp === VIEWPORTS[0]) await checkPage(browser, server.origin, path, vp, options).catch(() => {});
        rows.push({ path: entry.name ? `${entry.name} (${path.slice(0, 18)}…)` : path, vp, jsBudget: entry.jsKb, r: await checkPage(browser, server.origin, path, vp, options) });
      }
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  process.exit(report(rows, BUDGET) ? 0 : 1);
}

await main();
