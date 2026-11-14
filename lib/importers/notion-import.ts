// The Notion API import as the routes call it (POST /api/import/notion):
// "list" answers with the pages and databases the token sees, "import"
// reads the chosen ones (lib/importers/notion-api.ts) and writes them like
// any other import (lib/importers/write.ts), with the import report. The
// token is an argument here and nothing more: never stored, never logged.
import { all } from "../db";
import { HttpError } from "../auth";
import { jobProgress } from "../background-jobs";
import { maxUploadMbFor } from "../user-limits";
import { foldName } from "../page-properties";
import { checkNotionToken, listNotionRoots, parseNotionApi, type NotionClientOptions } from "./notion-api";
import { requireSpace, writeImport, type ImportResult } from "./write";
import type { Identity } from "../types";

const refuseDemo = (user: Identity) => {
  // The server would fetch for anonymous demo guests.
  if (user.demo) throw new HttpError(403, "Hier nicht verfügbar.");
};

export async function listNotion(user: Identity, workspaceId: string, spaceId: string, token: unknown, test: NotionClientOptions = {}) {
  refuseDemo(user);
  await requireSpace(user, workspaceId, spaceId);
  return { items: await listNotionRoots(checkNotionToken(token), test) };
}

export async function importNotion(
  user: Identity,
  workspaceId: string,
  spaceId: string,
  token: unknown,
  items: { id: string; kind: "page" | "database" }[],
  test: NotionClientOptions = {},
): Promise<ImportResult> {
  refuseDemo(user);
  const secret = checkNotionToken(token);
  await requireSpace(user, workspaceId, spaceId);
  if (!items.length) throw new HttpError(400, "Bitte wähle mindestens eine Seite oder Datenbank aus.");
  // People of Notion become the workspace's members with that name or e-mail.
  const members = await all<{ id: string; name: string; email: string }>(
    "SELECT u.id,u.name,u.email FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?",
    workspaceId,
  );
  const member = (person: { name?: string; email?: string }) =>
    members.find((m) => (person.email && m.email.toLowerCase() === person.email.toLowerCase()) || (person.name && foldName(m.name) === foldName(person.name)))?.id;
  const tree = await parseNotionApi(secret, items, { ...test, member, maxFileBytes: (await maxUploadMbFor(user)) * 1024 * 1024 });
  try {
    await jobProgress(0.9);
    return await writeImport(user, workspaceId, spaceId, tree, "pages");
  } finally {
    tree.close?.();
  }
}
