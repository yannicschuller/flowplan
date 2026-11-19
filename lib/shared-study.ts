// Flashcards through a share link or a publication (docs/specs/flashcards.md
// §7.3): the study view of a shared deck shows its cards to browse
// ("Durchblättern", server HTML) and to practise ("Üben", in the browser,
// components/study/public-practice.tsx). Nothing about a visitor is stored:
// the learning state lives in the visitor's localStorage only, the server
// hands out the cards and nothing else – no counter, no address.
//
// - Access is the link's own (lib/publication.ts publicPage): password and
//   end date (lib/share-access.ts), the pages of the share.
// - Only public properties: every property the card mapping reads must be
//   public (publicFieldIds, lib/shared-content.ts) – else there are no cards
//   at all, as in the app (rather none than half). Private records never.
// - Documents go out as on the published page (publishedHtml): files only
//   through the share's own paths, links outside the share removed.
// - At most PUBLIC_STUDY_PAGE cards per answer; `next` names the offset of
//   the next part.
import { moduleOff } from "./instance-modules";
import { all, one } from "./db";
import { HttpError } from "./auth";
import { publicFile, publicPage, publishedHtml } from "./publication";
import { publicFieldIds } from "./shared-content";
import { databaseSettings } from "./database-settings";
import { effectiveFilterGroup, filterCount, matchesFilterGroup } from "./database-filters";
import { isEncryptedPage } from "./e2ee-server";
import { deriveCards, needsDocument, studyFieldIds, type DerivedCard } from "./study-content";
import { choiceCandidates, documentHtml, poolRows, present, type ShownCard } from "./study";
import type { StudySettings } from "./study-schema";
import type { Field, Page, View } from "./types";

export const PUBLIC_STUDY_PAGE = 2000;

// Whether a deck's cards may be shown publicly: every property its mapping
// reads is public (and exists).
export function publicStudyMapping(settings: StudySettings | undefined, fields: Field[]): settings is StudySettings {
  if (!settings) return false;
  const shown = publicFieldIds(fields);
  return studyFieldIds(settings).every((id) => shown.has(id));
}

type Deck = { page: Page; pages: Page[]; fields: Field[]; views: View[]; settings: StudySettings };
// The deck behind a page of the share, or null (no database, no mapping, a
// mapping that reads properties the link does not show).
export async function publicStudyDeck(token: string, pageId?: string): Promise<Deck | null> {
  const { page, pages } = await publicPage(token, pageId);
  // Flashcards switched off for the instance (#386): no public studying.
  if (page.kind !== "database" || (await moduleOff("flashcards")) || (await isEncryptedPage(page))) return null;
  const raw = await one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", page.id);
  if (!raw) return null;
  const fields: Field[] = JSON.parse(raw.fields);
  const settings = (await databaseSettings(page.id)).study;
  if (!publicStudyMapping(settings, fields)) return null;
  return { page, pages, fields, views: JSON.parse(raw.views), settings };
}

type PublicRow = { id: string; cells: Record<string, unknown>; content: string | null };
// The records of the deck a visitor sees, in their order: not private,
// only public cells, the study view's filters (sub-decks) applied to them.
async function publicRecords(deck: Deck, view: View | undefined): Promise<PublicRow[]> {
  const shown = publicFieldIds(deck.fields);
  const group = view ? effectiveFilterGroup(view) : null;
  const filtered = !!group && filterCount(group) > 0;
  const now = new Date();
  const out: PublicRow[] = [];
  for (const r of await all<{ id: string; cells: string; content: string | null }>(
    "SELECT id,cells,content FROM rows WHERE page_id=? AND access!='private' ORDER BY position,id",
    deck.page.id,
  )) {
    const stored = JSON.parse(r.cells || "{}") as Record<string, unknown>;
    const cells = Object.fromEntries(Object.entries(stored).filter(([key]) => shown.has(key)));
    if (filtered && !matchesFilterGroup(cells, group!, deck.fields, now)) continue;
    out.push({ id: r.id, cells, content: r.content });
  }
  return out;
}

async function documentsOf(ids: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const d of await all<{ row_id: string; html: string }>(`SELECT row_id,html FROM row_documents WHERE row_id IN (${part.map(() => "?").join(",")})`, ...part))
      out.set(d.row_id, d.html);
  }
  return out;
}
// Cards of records; `publish`: documents as the link serves them.
async function cardsOf(deck: Deck, rows: PublicRow[], publish?: (html: string) => Promise<string>) {
  const needing = rows.filter((r) => needsDocument(deck.settings, r.cells));
  const docs = needing.length ? await documentsOf(needing.map((r) => r.id)) : new Map<string, string>();
  const out = new Map<string, DerivedCard[]>();
  for (const r of rows) {
    let html: string | null = null;
    if (needsDocument(deck.settings, r.cells)) {
      html = documentHtml(r, docs.get(r.id));
      if (publish) html = await publish(html);
    }
    out.set(r.id, deriveCards(deck.settings, deck.fields, r.cells, html));
  }
  return out;
}

// Whether the share serves a file, asked once per file: the deck's own
// files (used by its documents) without scanning every document again.
function fileCheck(token: string, deck: Deck) {
  const known = new Map<string, Promise<boolean>>();
  let own: Promise<Set<string>> | null = null;
  return (fileId: string) => {
    if (!known.has(fileId))
      known.set(
        fileId,
        (async () => {
          own ??= all<{ id: string }>("SELECT id FROM files WHERE page_id=? AND deleted_at IS NULL", deck.page.id).then((list) => new Set(list.map((f) => f.id)));
          if ((await own).has(fileId)) {
            // Files of the database are served when a public record uses
            // them (lib/publication.ts publicFile) – these documents are.
            if (await one("SELECT 1 FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=? AND r.access!='private' AND d.html LIKE ? LIMIT 1", deck.page.id, `%/api/files/${fileId}%`)) return true;
          }
          try {
            await publicFile(token, fileId);
            return true;
          } catch {
            return false;
          }
        })(),
      );
    return known.get(fileId)!;
  };
}

export type PublicStudyCard = Omit<ShownCard, "memory">;
export type PublicStudyAnswer = {
  pageId: string;
  title: string;
  viewId: string | null;
  // What the practice in the browser needs of the deck's settings.
  settings: Pick<StudySettings, "newPerDay" | "reviewsPerDay" | "retention" | "learningSteps" | "relearningSteps" | "maxInterval" | "buryNew" | "buryReviews" | "typedCompare">;
  total: number;
  offset: number;
  next: number | null;
  cards: PublicStudyCard[];
};

// The cards of a shared deck's study view (or of the whole deck), from
// `offset`, at most `limit` (≤ PUBLIC_STUDY_PAGE).
export async function sharedStudyCards(token: string, input: { pageId?: string; viewId?: string; offset?: number; limit?: number }): Promise<PublicStudyAnswer> {
  const deck = await publicStudyDeck(token, input.pageId);
  if (!deck) throw new HttpError(404, "Keine Lernkarten in dieser Freigabe.");
  const view = input.viewId ? deck.views.find((v) => v.id === input.viewId && v.type === "study") : undefined;
  if (input.viewId && !view) throw new HttpError(404, "Ansicht nicht gefunden.");
  const offset = Math.max(0, Math.floor(input.offset || 0));
  const limit = Math.max(1, Math.min(PUBLIC_STUDY_PAGE, Math.floor(input.limit || PUBLIC_STUDY_PAGE)));
  const rows = await publicRecords(deck, view);
  // Every card (without documents published) for the count and the part.
  const all = await cardsOf(deck, rows);
  const flat = rows.flatMap((r) => (all.get(r.id) || []).map((card) => ({ rowId: r.id, sub: card.sub })));
  const part = flat.slice(offset, offset + limit);
  const partRows = new Set(part.map((c) => c.rowId));
  const served = fileCheck(token, deck);
  const published = await cardsOf(
    deck,
    rows.filter((r) => partRows.has(r.id)),
    (html) => publishedHtml(html, token, deck.pages, undefined, served),
  );
  // Choice options come from the backs of the deck's other public cards,
  // the same records all day (as in the app, lib/study.ts).
  const day = new Date().toISOString().slice(0, 10);
  const pool = poolRows(rows.map((r) => r.id), day);
  const candidates = part.some((c) => published.get(c.rowId)?.some((d) => d.sub === c.sub && d.kind === "choice"))
    ? choiceCandidates(new Map(pool.map((id) => [id, all.get(id) || []])))
    : [];
  const cards = part.flatMap((c) => {
    const card = published.get(c.rowId)?.find((d) => d.sub === c.sub);
    if (!card) return [];
    const { memory: _none, ...shown } = present(card, { rowId: c.rowId, sub: c.sub, memory: null }, candidates);
    return [shown];
  });
  const s = deck.settings;
  return {
    pageId: deck.page.id,
    title: deck.page.title,
    viewId: view?.id ?? null,
    settings: {
      newPerDay: s.newPerDay,
      reviewsPerDay: s.reviewsPerDay,
      retention: s.retention,
      learningSteps: s.learningSteps,
      relearningSteps: s.relearningSteps,
      maxInterval: s.maxInterval,
      buryNew: s.buryNew,
      buryReviews: s.buryReviews,
      typedCompare: s.typedCompare,
    },
    total: flat.length,
    offset,
    next: offset + limit < flat.length ? offset + limit : null,
    cards,
  };
}
