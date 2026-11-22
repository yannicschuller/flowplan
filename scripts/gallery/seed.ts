import type { APIRequestContext } from "@playwright/test";
// @ts-ignore – plain JavaScript module
import { ACCOUNT, seedAccount } from "../production-server.mjs";
import type { Ids } from "./types";

// The visual tests' example content (scripts/production-server.mjs, in its
// English version) plus a page of every kind, a journal day, published
// pages, a share link and a form, so every scene has something to show.
// The gallery is recorded in English only (#438): the requests that seed it
// send an English Accept-Language (run.ts), so the server creates the
// workspace and its built-in pages in English too.

export const GALLERY_DAY = "2026-10-15"; // the day of FIXED_TIME

const SANDBOX_TITLE = "Sandbox";

export async function seedGallery(api: APIRequestContext, origin: string, { fresh }: { fresh: boolean }): Promise<Ids> {
  // A fresh server: the first account (an admin). An existing one (--url):
  // an account of its own, which only works while sign-up is open there.
  const account = fresh
    ? ACCOUNT
    : { ...ACCOUNT, email: `gallery-${Date.now()}@example.test` };
  const base = await seedAccount(api, origin, account, { language: "en" }).catch((error: Error) => {
    if (!fresh && /auth\/register/.test(error.message))
      throw new Error(`${origin} does not let a new account sign up (${error.message.slice(0, 160)}). The gallery uses an account of its own so it never changes yours: open sign-up there, or run without --url (the production build).`);
    throw error;
  });
  const command = commandFor(api, origin);
  const { workspaceId, spaceId } = base;
  // Every setting on screen (settings levels, #294): the gallery's account
  // is new, so it would follow the instance default ("Normal") and hide the
  // Expert ones – such as setting up end-to-end encryption.
  await command({ action: "profile.settingsLevel", level: "expert" }).catch(() => {});
  const create = async (kind: string, title: string, extra: Record<string, unknown> = {}) =>
    (await command({ action: "page.create", workspaceId, spaceId, kind, title, ...extra })).id as string;

  const whiteboardId = await create("whiteboard", "Q3 retro");
  const journalId = await create("journal", "Diary");
  await command({ action: "journal.roll", workspaceId, pageId: journalId, date: GALLERY_DAY }).catch(() => {});
  const notebookId = await create("notebook", "Sketches");
  const dashboardId = await create("dashboard", "Key figures");
  const sandboxId = await create("document", SANDBOX_TITLE);

  const read = async (id: string) => (await api.get(`/api/pages/${id}`)).json();
  const db = await read(base.databaseId);
  const rowId = db.rows?.[0]?.id as string;
  // A view of every layout next to table and board (each one on its own:
  // a layout the server refuses leaves out only itself).
  const views = [...db.database.views];
  for (const extra of [
    { id: "calendar", name: "Calendar", type: "calendar", filters: [], sorts: [], dateField: "date" },
    { id: "timeline", name: "Timeline", type: "timeline", filters: [], sorts: [], dateField: "date" },
    { id: "gallery", name: "Gallery", type: "gallery", filters: [], sorts: [] },
    { id: "list", name: "List", type: "list", filters: [], sorts: [] },
    { id: "chart", name: "Chart", type: "chart", filters: [], sorts: [], groupBy: "status" },
    { id: "feed", name: "Feed", type: "feed", filters: [], sorts: [] },
    // The form's own view (the scene "database-form-qr" opens it).
    { id: "form", name: "Form", type: "form", filters: [], sorts: [] },
  ]) {
    const current = (await read(base.databaseId)).database;
    await command({ action: "database.update", pageId: base.databaseId, version: current.version, fields: current.fields, views: [...views, extra] })
      .then(() => views.push(extra))
      .catch((e) => console.warn(`Gallery seed: no ${extra.type} view (${String(e.message).slice(0, 120)})`));
  }

  await seedTasks(api, command, { workspaceId, spaceId, parentId: sandboxId });

  await command({ action: "page.publish", pageId: base.documentId, enabled: true });
  const publicDocToken = (await read(base.documentId)).page.public_token as string;
  await command({ action: "page.publish", pageId: base.databaseId, enabled: true });
  const publicDbToken = (await read(base.databaseId)).page.public_token as string;
  const { token: shareLinkToken } = await command({
    action: "share.create",
    pageId: base.documentId,
    role: "editor",
    includeChildren: false,
    name: "Agency",
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

// Something to do for "My tasks" (#314), below "Sandbox": dated
// tasks in a document (own to-dos), a ticket database with a status and
// the account as assignee, and a reading list without a status, whose
// records are no tasks. Dates around GALLERY_DAY.
async function seedTasks(
  api: APIRequestContext,
  command: ReturnType<typeof commandFor>,
  { workspaceId, spaceId, parentId }: { workspaceId: string; spaceId: string; parentId: string },
) {
  const me = ((await (await api.get("/api/bootstrap")).json()).user?.id ?? "") as string;
  const create = async (kind: string, title: string) =>
    (await command({ action: "page.create", workspaceId, spaceId, parentId, kind, title })).id as string;
  const plan = await create("document", "Weekly planning");
  const task = (text: string, due: string) => `<li data-type="taskItem" data-checked="false" data-due="${due}"><p>${text}</p></li>`;
  const html = `<ul data-type="taskList">${[
    task("Send the quote to the agency", "2026-10-14"),
    task("Book a room for the workshop", "2026-10-15"),
    task("Prepare the presentation for Friday", "2026-10-16"),
    task("Hand in the quarterly report", "2026-10-28"),
  ].join("")}</ul>`;
  const { htmlState } = await import("../../lib/document-server");
  const { generation } = await (await api.get(`/api/pages/${plan}`)).json();
  await command({ action: "document.sync", pageId: plan, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  const database = async (title: string, fields: Record<string, unknown>[], rows: Record<string, unknown>[]) => {
    const id = await create("database", title);
    const current = (await (await api.get(`/api/pages/${id}`)).json()).database;
    await command({ action: "database.update", pageId: id, version: current.version, fields, views: current.views });
    for (const cells of rows) await command({ action: "row.create", pageId: id, cells });
  };
  await database(
    "Tickets",
    [
      { id: "title", name: "Title", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Open", "In progress", "Done"] },
      { id: "who", name: "Assignee", type: "person" },
      { id: "due", name: "Due", type: "date" },
      { id: "key", name: "ID", type: "id", prefix: "TIC" },
    ],
    [
      { title: "Sign-in on the tablet does not work", status: "In progress", who: me, due: "2026-10-13" },
      { title: "Check the PDF export", status: "Open", who: me, due: "2026-10-15" },
      { title: "Translate the help texts", status: "Open", who: me, due: "2026-10-19" },
      { title: "Tune the colours in dark mode", status: "In progress", who: me },
    ],
  );
  await database(
    "Reading list",
    [
      { id: "title", name: "Title", type: "text" },
      { id: "who", name: "Recommended for", type: "person" },
    ],
    [{ title: "Shape Up", who: me }],
  );
}

export function commandFor(api: APIRequestContext, origin: string) {
  return async (data: Record<string, unknown>) => {
    const response = await api.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(`${data.action}: ${response.status()} ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };
}
