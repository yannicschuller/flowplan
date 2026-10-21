// Page owners and review dates: a page can name a member who looks after
// it and a date by which it should be checked again ("Prüfdatum"), either
// once or every N days. Once the date has passed, the page shows a hint and
// its owner gets one reminder per due date; "Geprüft" moves the date on by
// the interval (from today) or clears a one-off date.
import { z } from "zod";
import { all, id, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { Temporal } from "./date-values";
import type { Identity, Page } from "./types";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  try {
    Temporal.PlainDate.from(v);
    return true;
  } catch {
    return false;
  }
});
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => Temporal.PlainDate.from(date).add({ days }).toString();

// Who may own a page: a member (not a guest) of its workspace who can read it.
function checkOwner(page: Page, ownerId: string) {
  const member = one<Identity>(
    `SELECT u.* FROM users u JOIN members m ON m.user_id=u.id AND m.workspace_id=?
     WHERE u.id=? AND u.disabled=0 AND NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=u.id)`,
    page.workspace_id,
    ownerId,
  );
  if (!member) throw new HttpError(400, "Besitzer muss Mitglied des Arbeitsbereichs sein.");
  if (!pageRole({ ...member, groups: [], isAdmin: false }, page))
    throw new HttpError(400, "Der Besitzer hat keinen Zugriff auf diese Seite.");
}

// Command "page.owner": { pageId, ownerId | null }.
export function setPageOwner(user: Identity, input: unknown) {
  const b = z.object({ pageId: z.string().uuid(), ownerId: z.string().min(1).max(60).nullable() }).parse(input);
  const page = requirePage(user, b.pageId, true);
  if (b.ownerId) checkOwner(page, b.ownerId);
  run("UPDATE pages SET owner_id=?,review_notified=NULL WHERE id=?", b.ownerId, page.id);
  return { ok: true };
}

// Command "page.review": { pageId, reviewAt?, everyDays?, done? }. An
// interval without a date starts from today; `done` marks the page as
// reviewed.
export function setPageReview(user: Identity, input: unknown) {
  const b = z
    .object({
      pageId: z.string().uuid(),
      reviewAt: day.nullable().optional(),
      everyDays: z.number().int().min(1).max(3650).nullable().optional(),
      done: z.literal(true).optional(),
    })
    .parse(input);
  const page = requirePage(user, b.pageId, true) as Page & { review_at: string | null; review_every_days: number | null };
  const every = b.everyDays !== undefined ? b.everyDays : page.review_every_days;
  let at = b.reviewAt !== undefined ? b.reviewAt : page.review_at;
  if (b.done) {
    if (!page.review_at) throw new HttpError(400, "Für diese Seite ist keine Prüfung geplant.");
    at = every ? addDays(today(), every) : null;
  } else if (!at && every) at = addDays(today(), every);
  run(
    "UPDATE pages SET review_at=?,review_every_days=?,review_notified=CASE WHEN review_at IS ? THEN review_notified ELSE NULL END WHERE id=?",
    at,
    every,
    at,
    page.id,
  );
  return { ok: true, reviewAt: at, everyDays: every };
}

type Due = { id: string; title: string; review_at: string; owner_id: string; review_notified: string | null };

// Pages whose review is due, owned by this person (the "waiting for review"
// list; bootstrap carries it for the start page).
export function reviewsDue(user: Identity, pages: (Page & { owner_id?: string | null; review_at?: string | null })[]) {
  const day = today();
  return pages
    .filter((p) => !p.deleted_at && p.owner_id === user.id && p.review_at && p.review_at <= day)
    .map((p) => ({ pageId: p.id, title: p.title, reviewAt: p.review_at! }))
    .sort((a, b) => a.reviewAt.localeCompare(b.reviewAt));
}

// Daily reminders (run by a background tick): one inbox notification per
// page and due date for its owner, while the owner can still read the page.
export function processPageReviews(now = Date.now()) {
  let sent = 0;
  const due = all<Due>(
    `SELECT id,title,review_at,owner_id,review_notified FROM pages
     WHERE review_at IS NOT NULL AND review_at<=? AND owner_id IS NOT NULL AND deleted_at IS NULL
       AND review_notified IS NOT review_at`,
    today(now),
  );
  for (const p of due) {
    const owner = one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", p.owner_id);
    const page = one<Page>("SELECT * FROM pages WHERE id=?", p.id);
    if (!owner || !page || !pageRole({ ...owner, groups: [], isAdmin: false }, page)) continue;
    transaction(() => {
      if (!run("UPDATE pages SET review_notified=? WHERE id=? AND review_notified IS NOT ?", p.review_at, p.id, p.review_at).changes) return;
      run(
        "INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'reminder')",
        id(),
        p.owner_id,
        `„${(p.title || "Ohne Titel").slice(0, 200)}“ wartet auf deine Prüfung`,
        p.id,
      );
      sent++;
    });
  }
  return sent;
}

const runtime = globalThis as typeof globalThis & { flowplanReviewTimer?: ReturnType<typeof setInterval> };
export function startReviewWorker(onSent: () => void) {
  if (runtime.flowplanReviewTimer) return;
  const tick = () => {
    try {
      if (processPageReviews()) onSent();
    } catch (error) {
      console.error("Page reviews failed", error);
    }
  };
  runtime.flowplanReviewTimer = setInterval(tick, 60 * 60_000);
  runtime.flowplanReviewTimer.unref();
  setTimeout(tick, 30_000).unref();
}
