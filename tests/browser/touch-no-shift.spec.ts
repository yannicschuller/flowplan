import { test, expect, type CDPSession, type Locator, type Page } from "@playwright/test";

// #377: in the iPhone/iPad app a page row moved a little to the side while
// a finger was on it. iOS applies :active while a finger rests on a button
// (or swipes over it) and keeps :hover on what was touched; the press
// feedback `button:active { scale: 0.98 }` shrank wide rows towards their
// middle, which moved their left edge – the icon and the title – sideways,
// and cards lifted on :hover. Movement on hover and press is for a mouse
// only now (@media (hover: hover) and (pointer: fine)).
//
// Chromium's synthetic touches do not set :active or :hover, so the states
// a finger gives are forced through the DevTools protocol, on the element
// and (:hover) on its ancestors, as a real touch would.

async function signIn(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function pressed(cdp: CDPSession, target: Locator, on: boolean) {
  const handle = await target.elementHandle();
  if (!handle) throw new Error("no element");
  // Mark the chain (element up to <body>) to find it through the protocol.
  const depth = await handle.evaluate((el) => {
    let n = 0;
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      e.setAttribute("data-press-chain", String(n));
      n++;
    }
    return n;
  });
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  for (let i = 0; i < depth; i++) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-press-chain="${i}"]` });
    await cdp.send("CSS.forcePseudoState", {
      nodeId,
      forcedPseudoClasses: on ? (i === 0 ? ["hover", "active"] : ["hover"]) : [],
    });
  }
  await handle.evaluate(() => document.querySelectorAll("[data-press-chain]").forEach((e) => e.removeAttribute("data-press-chain")));
}

// The boxes of the element and of what it shows (icon, title …).
const boxes = (target: Locator) =>
  target.evaluate((el) =>
    [el, ...el.querySelectorAll("*")].slice(0, 20).map((e) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
    }),
  );

test("rows and cards stay where they are under a finger (#377)", async ({ page }, testInfo) => {
  const touch = testInfo.project.name === "mobile";
  const title = `Test note ${Date.now()}`;
  await signIn(page, title);
  await page.goto("/");
  // Nothing animates into place while it is measured.
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");

  const check = async (name: string, target: Locator) => {
    await expect(target).toBeVisible();
    await target.scrollIntoViewIfNeeded();
    const before = await boxes(target);
    await pressed(cdp, target, true);
    const during = await boxes(target);
    const scale = await target.evaluate((el) => getComputedStyle(el).scale);
    await pressed(cdp, target, false);
    if (touch) {
      expect(during, `${name} moved under the finger`).toEqual(before);
      expect(scale, name).toBe("none");
    } else {
      // With a mouse a pressed button still gives a little.
      expect(scale, name).toBe("0.98");
    }
  };

  // The home page: the recently edited cards and the list of pages.
  await check("recent card", page.locator(".recent-card", { hasText: title }).first());
  const homeRow = page.locator(".home-page-row").first();
  if (await homeRow.isVisible()) await check("home page row", homeRow);
  // The page in the sidebar (on a phone opened over the home page).
  if (touch) await page.locator(".topbar .mobile-menu").tap();
  await check("sidebar page", page.locator(".page-nav", { hasText: title }).first().locator(".page-nav-title"));
});
