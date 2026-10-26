import { test, expect, type Page } from "@playwright/test";

// Touch targets on a phone (390 px): every button, link, tab, checkbox and
// handle can be hit in an area of at least 44 × 44 px – its own box, its
// padding or an invisible ::after around it (app/mobile-ux.css, "Hit
// areas"). The test measures what a finger actually hits: from the middle of
// each element outwards, as far as document.elementFromPoint still finds
// the element (or its label), so a neighbour that lies over the area counts
// against it. The window's edges count as part of the area (a finger cannot
// miss beyond them).

const MIN = 44;
// Interactive elements that may stay smaller, each with its reason.
const ALLOWED: { selector: string; reason: string }[] = [
  { selector: ".ProseMirror a, .read-only-document a, p a, li > a:not([class]), small a", reason: "links inside running text: the line height is the text's" },
  { selector: ".sheet-handle", reason: "the grab handle is a strip across the sheet, not a target" },
  { selector: "nextjs-portal, [data-nextjs-toast]", reason: "the development overlay of Next.js" },
];
const INTERACTIVE = [
  "button",
  "a[href]",
  "summary",
  "select",
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="option"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[draggable="true"]',
].join(", ");

type Small = { name: string; width: number; height: number };

// The elements below the size, measured in the page.
async function smallTargets(page: Page, scope = "body"): Promise<Small[]> {
  return page.evaluate(
    async ({ scope, selector, allowed, min }) => {
      const root = document.querySelector(scope);
      if (!root) return [{ name: `missing scope ${scope}`, width: 0, height: 0 }];
      const name = (el: Element) => {
        const label = (el.getAttribute("aria-label") || (el as HTMLElement).innerText?.trim().slice(0, 30) || el.getAttribute("title") || "").replace(/\s+/g, " ");
        const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
        return `${el.tagName.toLowerCase()}${cls} "${label}"`;
      };
      const visible = (el: HTMLElement) => {
        if (el.closest('[aria-hidden="true"], [inert], [hidden]')) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05 && style.pointerEvents !== "none";
      };
      const out: { name: string; width: number; height: number }[] = [];
      const seen = new Set<Element>();
      const list = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => !allowed.some((a) => el.matches(a)));
      for (const el of list) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        // From the start of sideways scrolling lists (a table scrolled to
        // its end lets its sticky first column slide over the selection).
        for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollLeft) p.scrollLeft = 0;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        await new Promise(requestAnimationFrame);
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const cx = r.left + r.width / 2,
          cy = r.top + r.height / 2;
        // Only what is on the screen at all.
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        const labels = [...((el as HTMLInputElement).labels || [])];
        const owns = (t: Element | null) => !!t && (t === el || el.contains(t) || labels.some((l) => l.contains(t)));
        const hit = (x: number, y: number) => x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || owns(document.elementFromPoint(x, y));
        // Covered by something else at its middle: not a target now.
        if (!owns(document.elementFromPoint(cx, cy))) continue;
        const reach = (dx: number, dy: number) => {
          let d = 0;
          while (d < min && hit(cx + dx * (d + 1), cy + dy * (d + 1))) d++;
          return d;
        };
        // The run of points through the middle that still hit it, across
        // and down (not necessarily centred on the element).
        const width = Math.min(min, reach(-1, 0) + reach(1, 0) + 1);
        const height = Math.min(min, reach(0, -1) + reach(0, 1) + 1);
        if (width < min - 1 || height < min - 1) out.push({ name: `${name(el)} at ${Math.round(r.left)},${Math.round(r.top)}`, width, height });
      }
      return out;
    },
    { scope, selector: INTERACTIVE, allowed: ALLOWED.map((a) => a.selector), min: MIN },
  );
}

async function setup(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  // The welcome page has headings, a link and a task list.
  const doc = (boot.pages as { id: string; kind: string; title: string }[]).find((p) => p.kind === "document" && /Willkommen|Welcome/.test(p.title))!;
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `Tabelle ${Date.now()}` });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Angebot schreiben" } });
  return { doc, db, row };
}

const report = (screen: string, small: Small[]) => small.map((s) => `${screen}: ${s.name} ${s.width}×${s.height}`);

test("touch targets are at least 44 × 44 px on a phone", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch targets are measured on a phone.");
  test.setTimeout(180_000);
  const { doc, db, row } = await setup(page);
  const found: string[] = [];

  await page.goto("/#home");
  await expect(page.locator(".home-grid")).toBeVisible();
  found.push(...report("home", await smallTargets(page)));

  await page.goto(`/#page=${doc.id}`);
  await expect(page.locator('.ProseMirror li[data-checked]').first()).toBeVisible();
  found.push(...report("document", await smallTargets(page)));

  await page.goto(`/#page=${db.id}`);
  await expect(page.getByText("Angebot schreiben").first()).toBeVisible();
  found.push(...report("database", await smallTargets(page)));

  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const record = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(record).toBeVisible();
  await page.waitForTimeout(400);
  found.push(...report("record", await smallTargets(page, '[role="dialog"]')));
  await page.keyboard.press("Escape");

  await page.goto("/#settings");
  await expect(page.locator(".settings-tile").first()).toBeVisible();
  found.push(...report("settings", await smallTargets(page)));

  await page.goto("/#settings/account");
  await expect(page.locator(".settings-detail .setting-group").first()).toBeVisible();
  found.push(...report("settings section", await smallTargets(page)));

  // The navigation drawer.
  await page.goto(`/#page=${doc.id}`);
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await expect(page.locator(".nav-open .sidebar")).toBeVisible();
  await page.waitForTimeout(300);
  found.push(...report("sidebar", await smallTargets(page, ".sidebar")));

  expect(found, found.join("\n")).toEqual([]);
});
