// Page cards with the whole document (#549): when a card shows it, the
// wheel inside it, and the server's full preview (sanitized HTML, never
// for encrypted spaces, only with read access).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-cards-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");
const { pagePreview } = await import("../lib/page-preview");
const { fullPageCard, newPageCard, wheelScrollsCard, FULL_CARD_MIN } = await import("../lib/whiteboard-page-cards");

const view = { x: 0, y: 0, w: 1200, h: 800, zoom: 1 };

test("only large cards in view, readable at the zoom, show the document", () => {
  const card = { x: 100, y: 100, w: 420, h: 320 };
  assert.equal(fullPageCard(card, view), true);
  assert.equal(fullPageCard({ ...card, w: 280, h: 80 }, view), false, "today's small card");
  assert.equal(fullPageCard({ ...card, h: FULL_CARD_MIN.h - 1 }, view), false);
  assert.equal(fullPageCard(card, { ...view, zoom: 0.3, w: 4000, h: 2666 }), false, "too small on screen");
  assert.equal(fullPageCard({ ...card, x: 1500 }, view), true, "just beside the view stays loaded");
  assert.equal(fullPageCard({ ...card, x: 5000 }, view), false, "far away");
  assert.equal(fullPageCard({ ...card, y: -3000 }, view), false);
});

test("a new page's card is large enough for its document and centred", () => {
  const box = newPageCard({ x: 500, y: 300 }, view);
  assert.deepEqual(box, { x: 280, y: 130, w: 440, h: 340 });
  assert.equal(fullPageCard(box, view), true);
  // A phone: smaller, never below the size that shows the document.
  const small = newPageCard({ x: 0, y: 0 }, { w: 340, h: 500 });
  assert.ok(small.w >= FULL_CARD_MIN.w && small.h >= FULL_CARD_MIN.h);
});

test("the wheel scrolls a card only when selected or rested on, and while it can", () => {
  const base = { selected: true, hoverSince: null, lastPan: 0, now: 10_000, deltaY: 40, scrollTop: 0, scrollHeight: 900, clientHeight: 300 };
  assert.equal(wheelScrollsCard(base), true);
  assert.equal(wheelScrollsCard({ ...base, deltaY: -40 }), false, "at the top: the board scrolls");
  assert.equal(wheelScrollsCard({ ...base, scrollTop: 600 }), false, "at the end: the board scrolls");
  assert.equal(wheelScrollsCard({ ...base, scrollHeight: 300 }), false, "nothing to scroll");
  assert.equal(wheelScrollsCard({ ...base, selected: false }), false, "passing over it while panning");
  assert.equal(wheelScrollsCard({ ...base, selected: false, hoverSince: 9_900 }), false, "just arrived");
  assert.equal(wheelScrollsCard({ ...base, selected: false, hoverSince: 9_000 }), true, "rested on it");
  assert.equal(wheelScrollsCard({ ...base, selected: false, hoverSince: 9_000, lastPan: 9_900 }), false, "a pan goes on");
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("the full preview: sanitized HTML for readers, nothing for others or encrypted spaces", async () => {
  const owner = await account("Olga"),
    stranger = await account("Sam");
  const wid = await createWorkspace(owner.id, "Firma");
  await createWorkspace(stranger.id, "Andere");
  const act = async (input: Record<string, unknown>) => (await api.command(owner, input)) as { id: string };
  const space = (await act({ action: "space.create", workspaceId: wid, name: "Team" })).id;
  const page = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Plan", kind: "document" })).id;
  await run(
    "UPDATE documents SET html=? WHERE page_id=?",
    '<h2>Ziele</h2><ul><li>Eins</li></ul><img src="/api/files/00000000-0000-4000-8000-000000000001" onerror="alert(1)"><script>alert(2)</script>',
    page,
  );
  const full = (await pagePreview(owner, page, { full: true })) as { html?: string; encrypted?: boolean; excerpt: string };
  assert.match(full.html || "", /<h2>Ziele<\/h2>/);
  assert.match(full.html || "", /<li>Eins<\/li>/);
  assert.match(full.html || "", /src="\/api\/files\//);
  assert.doesNotMatch(full.html || "", /onerror|<script/);
  assert.equal(full.encrypted, undefined);
  // Without `full`: as before, no HTML.
  assert.equal("html" in (await pagePreview(owner, page)), false);
  // No access: refused as for the short preview.
  await assert.rejects(() => pagePreview(stranger, page, { full: true }), (e: { status?: number }) => e.status === 403 || e.status === 404);
  // An end-to-end encrypted space: never its content.
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  const sealed = (await pagePreview(owner, page, { full: true })) as { html?: string; encrypted?: boolean; excerpt: string };
  assert.equal(sealed.encrypted, true);
  assert.equal(sealed.html, "");
  assert.equal(sealed.excerpt, "");
});
