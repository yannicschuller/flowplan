import type { APIRequestContext } from "@playwright/test";
// @ts-ignore – plain JavaScript module
import { ACCOUNT, seedAccount } from "../production-server.mjs";
import type { Ids } from "./types";

// The visual tests' example content (scripts/production-server.mjs) plus a
// page of every kind, a journal day, published pages, a share link and a
// form, so every scene has something to show.

export const GALLERY_DAY = "2026-10-15"; // the day of FIXED_TIME

const SANDBOX_TITLE = "Spielwiese";

export async function seedGallery(api: APIRequestContext, origin: string, { fresh }: { fresh: boolean }): Promise<Ids> {
  // A fresh server: the first account (an admin). An existing one (--url):
  // an account of its own, which only works while sign-up is open there.
  const account = fresh
    ? ACCOUNT
    : { ...ACCOUNT, email: `gallery-${Date.now()}@example.test` };
  const base = await seedAccount(api, origin, account).catch((error: Error) => {
    if (!fresh && /auth\/register/.test(error.message))
      throw new Error(`${origin} does not let a new account sign up (${error.message.slice(0, 160)}). The gallery uses an account of its own so it never changes yours: open sign-up there, or run without --url (the production build).`);
    throw error;
  });
  const command = commandFor(api, origin);
  const { workspaceId, spaceId } = base;
  const create = async (kind: string, title: string, extra: Record<string, unknown> = {}) =>
    (await command({ action: "page.create", workspaceId, spaceId, kind, title, ...extra })).id as string;

  const whiteboardId = await create("whiteboard", "Retro Q3");
  const journalId = await create("journal", "Tagebuch");
  await command({ action: "journal.roll", workspaceId, pageId: journalId, date: GALLERY_DAY }).catch(() => {});
  const notebookId = await create("notebook", "Skizzen");
  const dashboardId = await create("dashboard", "Kennzahlen");
  const sandboxId = await create("document", SANDBOX_TITLE);

  const read = async (id: string) => (await api.get(`/api/pages/${id}`)).json();
  const db = await read(base.databaseId);
  const rowId = db.rows?.[0]?.id as string;
  // A view of every layout next to table and board (each one on its own:
  // a layout the server refuses leaves out only itself).
  const views = [...db.database.views];
  for (const extra of [
    { id: "calendar", name: "Kalender", type: "calendar", filters: [], sorts: [], dateField: "date" },
    { id: "timeline", name: "Zeitleiste", type: "timeline", filters: [], sorts: [], dateField: "date" },
    { id: "gallery", name: "Galerie", type: "gallery", filters: [], sorts: [] },
    { id: "list", name: "Liste", type: "list", filters: [], sorts: [] },
    { id: "chart", name: "Diagramm", type: "chart", filters: [], sorts: [], groupBy: "status" },
    { id: "feed", name: "Feed", type: "feed", filters: [], sorts: [] },
  ]) {
    const current = (await read(base.databaseId)).database;
    await command({ action: "database.update", pageId: base.databaseId, version: current.version, fields: current.fields, views: [...views, extra] })
      .then(() => views.push(extra))
      .catch((e) => console.warn(`Gallery seed: no ${extra.type} view (${String(e.message).slice(0, 120)})`));
  }

  await command({ action: "page.publish", pageId: base.documentId, enabled: true });
  const publicDocToken = (await read(base.documentId)).page.public_token as string;
  await command({ action: "page.publish", pageId: base.databaseId, enabled: true });
  const publicDbToken = (await read(base.databaseId)).page.public_token as string;
  const { token: shareLinkToken } = await command({
    action: "share.create",
    pageId: base.documentId,
    role: "editor",
    includeChildren: false,
    name: "Agentur",
  });
  await command({ action: "form.update", pageId: base.databaseId, enabled: true, internal: false, anonymous: true });
  const formToken = (await read(base.databaseId)).form?.token as string;

  return {
    workspaceId,
    spaceId,
    documentId: base.documentId,
    databaseId: base.databaseId,
    workflowId: base.workflowId,
    whiteboardId,
    journalId,
    notebookId,
    dashboardId,
    sandboxId,
    rowId,
    publicDocToken,
    publicDbToken,
    shareLinkToken,
    formToken,
  };
}

export function commandFor(api: APIRequestContext, origin: string) {
  return async (data: Record<string, unknown>) => {
    const response = await api.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(`${data.action}: ${response.status()} ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };
}
