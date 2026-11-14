// "Beispielbereich" (components/onboarding.tsx, step "Womit möchtest du
// starten?"): a private space with a few example pages to try things on,
// created with one click and removed with one click. sample_spaces keeps
// which space it is and which pages it made, so removing it takes exactly
// those: pages the person added to the space themself stay (with the
// space), pages they moved elsewhere stay where they are.
import { z } from "zod";
import { all, id, lockMembership, one, run } from "./db";
import { HttpError } from "./auth";
import { requireMember } from "./permissions";
import { createPage } from "./seed";
import { contentLocale, ct } from "./content-locale";
import { applyStarterTemplate } from "./starter-templates";
import { callout, table, task, tasks, toggle } from "./template-catalog";
import { purgePages, purgeSpace } from "./workspace-lifecycle";
import { htmlState } from "./document-server";
import type { Identity, Page, Space } from "./types";

type SampleRow = { space_id: string; page_ids: string; created_at: number };

const ids = (text: string): string[] => {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

// The person's sample in this workspace (one at most), while its space exists.
export async function sampleSpaceOf(user: Pick<Identity, "id">, workspaceId: string) {
  const row = await one<SampleRow & { name: string; deleted_at: string | null }>(
    "SELECT x.space_id,x.page_ids,x.created_at,s.name,s.deleted_at FROM sample_spaces x JOIN spaces s ON s.id=x.space_id WHERE x.workspace_id=? AND x.user_id=?",
    workspaceId,
    user.id,
  );
  if (!row) return null;
  return { spaceId: row.space_id, name: row.name, pages: ids(row.page_ids).length, trashed: !!row.deleted_at, createdAt: row.created_at };
}

// The welcome page in the content language: German, or English for every
// other language (as the template catalog, lib/template-catalogs.ts).
const welcomeHtml = () =>
  contentLocale() === "de"
    ? `<h2>Hier darfst du alles ausprobieren</h2><p>Dieser Bereich ist nur für dich und gehört nicht zu deinen eigentlichen Inhalten. Ändere, verschiebe und lösche, was du willst – mit „Beispielbereich entfernen“ in der Checkliste „Erste Schritte“ oder in der Einführung verschwindet er wieder, samt allem, was hier angelegt wurde.</p>${callout("<p>Tippe <code>/</code> in eine leere Zeile, um einen Block einzufügen, und <code>@</code>, um eine Seite, ein Datum oder eine Person zu erwähnen.</p>")}<h2>Zum Üben</h2>${tasks(task("Diese Aufgabe abhaken"), task("Unter dieser Liste mit / eine Überschrift einfügen"), task("Die Seite „Projektplanung“ öffnen und eine Karte im Board verschieben"), task("Auf dem Whiteboard einen Notizzettel anlegen"))}${toggle("Was ist ein aufklappbarer Block?", "<p>Ein Block, dessen Inhalt erst beim Klick auf den Pfeil erscheint – praktisch für Details, FAQs und lange Notizen.</p>")}<h2>Was hier liegt</h2>${table([["Seite", "Was du daran ausprobieren kannst"], ["Projektplanung", "Datenbank mit Tabelle, Board und Zeitleiste, Eigenschaften und Filtern"], ["Team-Wiki", "Unterseiten, Inhaltsverzeichnis und Verlinkungen"], ["Ideen-Whiteboard", "Formen, Notizzettel, Verbindungen und Freihand"]])}`
    : `<h2>Try anything here</h2><p>This space is just for you and is not part of your real content. Change, move and delete whatever you like – “Remove sample space” in the “Getting started” checklist or in the introduction makes it go away again, with everything that was created here.</p>${callout("<p>Type <code>/</code> on an empty line to insert a block, and <code>@</code> to mention a page, a date or a person.</p>")}<h2>To practise</h2>${tasks(task("Tick off this task"), task("Insert a heading below this list with /"), task("Open the page “Project planning” and move a card on the board"), task("Add a sticky note on the whiteboard"))}${toggle("What is a toggle?", "<p>A block whose content only shows when you click the arrow – handy for details, FAQs and long notes.</p>")}<h2>What is in here</h2>${table([["Page", "What you can try on it"], ["Project planning", "A database with table, board and timeline, properties and filters"], ["Team wiki", "Sub-pages, table of contents and links"], ["Ideas whiteboard", "Shapes, sticky notes, connectors and freehand"]])}`;

// Creates the sample (or answers with the one there is). Inside the
// command's transaction.
export async function createSampleSpace(user: Identity, workspaceId: string) {
  await lockMembership(workspaceId);
  await requireMember(user, workspaceId, "editor");
  const existing = await sampleSpaceOf(user, workspaceId);
  if (existing && !existing.trashed) return existing;
  // A sample in the trash: removed for good before the new one.
  if (existing) await removeSampleSpace(user, workspaceId);
  const sid = id();
  await run(
    "INSERT INTO spaces(id,workspace_id,name,visibility,owner_id,icon,icon_color) VALUES(?,?,?,?,?,?,?)",
    sid,
    workspaceId,
    ct("Beispielbereich", "Sample space"),
    "private",
    user.id,
    "🧪",
    "none",
  );
  const made: string[] = [];
  const page = async (title: string, kind = "document", parent: string | null = null) => {
    const pid = await createPage(workspaceId, sid, user.id, title, kind, parent);
    made.push(pid);
    return pid;
  };
  const welcome = await page(ct("Willkommen im Beispielbereich", "Welcome to the sample space"));
  const html = welcomeHtml();
  await run("UPDATE pages SET icon=? WHERE id=?", "👋", welcome);
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), welcome);
  const project = await page(ct("Projektplanung", "Project planning"), "database");
  await applyStarterTemplate(project, user.id, "project");
  const wiki = await page(ct("Team-Wiki", "Team wiki"));
  await applyStarterTemplate(wiki, user.id, "wiki");
  const meeting = await page(ct("Besprechungsnotiz", "Meeting note"), "document", wiki);
  await applyStarterTemplate(meeting, user.id, "meetingNote");
  const board = await page(ct("Ideen-Whiteboard", "Ideas whiteboard"), "whiteboard");
  void board;
  await run(
    "INSERT INTO sample_spaces(space_id,workspace_id,user_id,page_ids,created_at) VALUES(?,?,?,?,?)",
    sid,
    workspaceId,
    user.id,
    JSON.stringify(made),
    Date.now(),
  );
  return (await sampleSpaceOf(user, workspaceId))!;
}

// Removes what the sample created: its pages still in the sample space,
// for good (not to the trash – it was only for trying). Pages the person
// added there keep the space (it stays, without the sample's pages); an
// empty space goes as well, unless it is the last active space.
export async function removeSampleSpace(user: Identity, workspaceId: string) {
  await requireMember(user, workspaceId, "editor");
  const row = await one<SampleRow>("SELECT space_id,page_ids,created_at FROM sample_spaces WHERE workspace_id=? AND user_id=?", workspaceId, user.id);
  if (!row) throw new HttpError(404, "Kein Beispielbereich vorhanden.");
  const space = await one<Space>("SELECT * FROM spaces WHERE id=?", row.space_id);
  if (!space) {
    await run("DELETE FROM sample_spaces WHERE space_id=?", row.space_id);
    return { removedPages: 0, keptPages: 0, spaceRemoved: true };
  }
  const tracked = new Set(ids(row.page_ids));
  const inSpace = await all<Page>("SELECT * FROM pages WHERE space_id=?", space.id);
  const remove = inSpace.filter((p) => tracked.has(p.id));
  const kept = inSpace.filter((p) => !tracked.has(p.id));
  const others = Number((await one<{ n: number }>("SELECT count(*) n FROM spaces WHERE workspace_id=? AND deleted_at IS NULL AND id<>?", workspaceId, space.id))?.n || 0);
  let spaceRemoved = false;
  if (!kept.length && (others > 0 || space.deleted_at)) {
    await purgeSpace(space);
    spaceRemoved = true;
  } else {
    // purgePages lifts the person's own sub-pages to the top of the space.
    await purgePages(workspaceId, remove);
    await run("DELETE FROM sample_spaces WHERE space_id=?", space.id);
  }
  return { removedPages: remove.length, keptPages: kept.length, spaceRemoved };
}

export async function sampleSpaceCommand(user: Identity, action: string, input: Record<string, unknown>) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  const workspaceId = z.uuid().parse(input.workspaceId);
  if (action === "sample.create") return await createSampleSpace(user, workspaceId);
  if (action === "sample.remove") return await removeSampleSpace(user, workspaceId);
  throw new HttpError(400, "Unbekannte Aktion.");
}
