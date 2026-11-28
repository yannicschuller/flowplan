// Links to issues and pull requests (#654): the state icon at the link and
// the hover card. The provider is mocked at Flowplan's own preview route
// (POST /api/issue-sync/preview) – the server's side towards GitHub, GitLab
// and Forgejo is covered by tests/issue-preview.test.ts; no request leaves
// the machine.
import { test, expect, type Page } from "@playwright/test";

// ISSUE_LINK_SCREENSHOTS=<dir>: the card in light and dark, for review.
const shots = process.env.ISSUE_LINK_SCREENSHOTS || "";
const ISSUE = "https://github.com/outline/outline/issues/6821";
const PULL = "https://github.com/acme/web/pull/12";
const PRIVATE = "https://github.com/acme/secret/issues/5";

function previews(asked: string[][]) {
  return async (page: Page) =>
    await page.route("**/api/issue-sync/preview", async (route) => {
      const { urls } = route.request().postDataJSON() as { urls: string[] };
      asked.push(urls);
      const answer: Record<string, unknown> = {};
      for (const url of urls) {
        if (url === ISSUE)
          answer[url] = {
            url,
            provider: "github",
            host: "github.com",
            repo: "outline/outline",
            number: 6821,
            kind: "issue",
            state: "open",
            title: "Command to clear IndexedDB cache does not work in Firefox",
            author: "tommoor",
            createdAt: new Date(Date.now() - 86_400_000).toISOString(),
            excerpt: "Running “Clear IndexedDB cache” from the command bar does nothing in Firefox 132; the cache stays and the page keeps the old documents.",
            labels: [
              { name: "bug", color: "#d73a4a" },
              { name: "firefox", color: "#0e8a16" },
            ],
          };
        else if (url === PULL)
          answer[url] = { url, provider: "github", host: "github.com", repo: "acme/web", number: 12, kind: "pull", state: "merged", title: "Fix the cache", author: "ana", createdAt: new Date().toISOString(), excerpt: "", labels: [] };
        else answer[url] = { url, error: "private" };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ previews: answer }) });
    });
}

test("issue links show their state at the link and a card on hover", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Hover");
  const asked: string[][] = [];
  await previews(asked)(page);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Issue-Links ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${doc.id}`)).json()).generation;
  await command({
    action: "document.sync",
    pageId: doc.id,
    generation,
    update: Buffer.from(
      htmlState(
        `<p>Siehe <a href="${ISSUE}">das Issue</a> und <a href="${PULL}">den Pull Request</a>, auch <a href="${PRIVATE}">das private</a> und <a href="https://example.com/a">eine Seite</a>.</p>`,
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${doc.id}`);
  const issue = page.locator(`.document-editor a[href="${ISSUE}"]`);
  await expect(issue).toBeVisible();
  // The state icons, without hovering: asked for in one batch, only issue links.
  await expect(issue.locator(".issue-state-icon")).toHaveAttribute("data-state", "open");
  await expect(page.locator(`.document-editor a[href="${PULL}"] .issue-state-icon`)).toHaveAttribute("data-state", "merged");
  await expect(page.locator(`.document-editor a[href="${PRIVATE}"] .issue-state-icon`)).toHaveCount(0);
  expect(asked.flat().sort()).toEqual([ISSUE, PRIVATE, PULL].sort());
  expect(asked.length).toBe(1);

  // The card: from the store, no second request.
  await issue.hover();
  const card = page.locator(".link-preview.issue-preview");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Command to clear IndexedDB cache does not work in Firefox");
  await expect(card).toContainText("outline/outline #6821");
  await expect(card).toContainText("Offen");
  await expect(card).toContainText("tommoor hat es gestern erstellt");
  // The provider's colour, as a custom property (no style attribute in the markup).
  const bug = card.locator(".issue-label", { hasText: "bug" });
  await expect(bug).toHaveCSS("--issue-label", "#d73a4a");
  await expect(bug).toHaveCSS("border-color", /0\.843137 0\.227451 0\.290196|215, 58, 74/);
  await expect(card.locator("p")).toContainText("Clear IndexedDB cache");
  expect(asked.length).toBe(1);
  if (shots) {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await card.evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished.catch(() => {}))));
      const box = (await card.boundingBox())!;
      await page.screenshot({ path: `${shots}/issue-card-${scheme}.png`, clip: { x: Math.max(0, box.x - 160), y: Math.max(0, box.y - 70), width: box.width + 320, height: box.height + 110 } });
    }
    await page.emulateMedia({ colorScheme: "light" });
  }
  // Leaving the link closes the card; the private one says why it is empty.
  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
  await page.locator(`.document-editor a[href="${PRIVATE}"]`).hover();
  await expect(card).toContainText("Privates Repository – nicht verfügbar");
  // Plain links get no issue card.
  await page.locator('.document-editor a[href="https://example.com/a"]').hover();
  await page.waitForTimeout(600);
  await expect(card).toHaveCount(0);
  await command({ action: "page.delete", pageId: doc.id });
});
