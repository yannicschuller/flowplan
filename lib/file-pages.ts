// Files uploaded straight into a space (#569): each file becomes a page of
// its own – a normal document titled with the file's name, holding the
// file's block (lib/file-blocks.ts: picture, PDF, Office or spreadsheet
// card, player …) and an empty line to write below it – at the top level
// of a space or below a page. So it shows up in the tree, the search,
// links, shares and permissions like any page.
//
// The web app uploads with POST /api/upload, purpose "page" (a file
// dropped on the sidebar's tree, "Datei hochladen …" in "Neue Seite", the
// media view's upload); the phone's share sheet with POST
// /api/mobile/capture/save, place "pages" (lib/mobile-capture.ts). Both
// make the page with the web app's own command (page.create, the same
// checks as "Neue Seite") and store the file with the page's upload
// (lib/page-upload.ts) – quota, storage and the page in one transaction:
// a refused file leaves no page, a refused page no file.
import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { command } from "./api";
import { ct } from "./content-locale";
import { cleanHtml, htmlState, jsonHtml } from "./document-server";
import { fileBlock, filePageTitle } from "./file-blocks";
import { kindModule, requireModule } from "./instance-modules";
import { requireUnlocked } from "./journal-extras";
import { pageLocationHash } from "./page-location";
import { storeUpload, storeUploadFile } from "./page-upload";
import { isGuest, requireMember, requirePage, spaceRole } from "./permissions";
import type { Identity, Space } from "./types";

export const filePagePlaceSchema = z.object({
  spaceId: z.uuid(),
  // Below this page; none: at the top level of the space.
  parentId: z.uuid().nullish(),
});
export type FilePagePlace = { workspaceId: string; spaceId: string; parentId: string | null };

type SpaceRow = Space & { encrypted?: number; encrypt_titles?: number };
const writes = (role: string | null) => role === "editor" || role === "owner";

// Where the pages go, checked before the file is read: a space the person
// may make pages in (not an encrypted one – their files and titles are
// encrypted in the browser), and a page of it they may edit and that is
// not behind a journal PIN. page.create checks all of it again.
export async function filePagePlace(user: Identity, raw: unknown): Promise<FilePagePlace> {
  const { spaceId, parentId } = filePagePlaceSchema.parse(raw);
  const space = await one<SpaceRow>("SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL", spaceId);
  if (!space) throw new HttpError(404, ct("Bereich nicht gefunden.", "Space not found."));
  await requireMember(user, space.workspace_id, "editor");
  if (!writes(await spaceRole(user, space))) throw new HttpError(403, ct("Du darfst in diesem Bereich keine Seiten anlegen.", "You may not create pages in this space."));
  if (space.encrypted || space.encrypt_titles)
    throw new HttpError(409, ct("In verschlüsselten Bereichen geht das Hochladen als Seite nicht.", "Uploading as pages is not available in encrypted spaces."));
  await requireModule(kindModule("document"));
  if (parentId) {
    const parent = await requirePage(user, parentId, true);
    await requireUnlocked(user, parent);
    if (parent.space_id !== space.id) throw new HttpError(400, ct("Die Seite liegt in einem anderen Bereich.", "The page is in another space."));
  }
  return { workspaceId: space.workspace_id, spaceId: space.id, parentId: parentId ?? null };
}

// The document of a page made from a file: the file's block and an empty
// paragraph below it.
export function filePageHtml(file: { url: string; name: string; mime: string }) {
  return cleanHtml(jsonHtml({ type: "doc", content: [fileBlock({ url: file.url, name: file.name, type: file.mime }), { type: "paragraph" }] }));
}

export type FilePage = { pageId: string; title: string; url: string; file: string };

// One file, one page. `file` is checked already (type from its content,
// name sanitised, location removed): bytes in memory, or a temporary file
// that is moved into place (lib/multipart-stream.ts).
export async function createFilePage(
  user: Identity,
  place: FilePagePlace,
  file: { id: string; name: string; mime: string } & ({ content: Buffer } | { path: string; size: number }),
): Promise<FilePage> {
  const url = `/api/files/${file.id}`;
  const title = filePageTitle(file.name) || ct("Datei", "File");
  const html = filePageHtml({ url, name: file.name, mime: file.mime });
  const owner = {
    workspace_id: place.workspaceId,
    create: async () => {
      const created = (await command(
        user,
        { action: "page.create", workspaceId: place.workspaceId, spaceId: place.spaceId, ...(place.parentId ? { parentId: place.parentId } : {}), title, kind: "document" },
        true,
      )) as { id: string };
      await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), created.id);
      return created.id;
    },
  };
  const pageId =
    "content" in file
      ? await storeUpload(user, owner, { id: file.id, name: file.name, mime: file.mime, content: file.content })
      : await storeUploadFile(user, owner, { id: file.id, name: file.name, mime: file.mime, size: file.size, path: file.path });
  return { pageId, title, url: `/${pageLocationHash({ pageId })}`, file: url };
}

// The spaces a person may make pages in, for the phone's share sheet:
// not encrypted, not deleted, with the workspace's name.
export async function filePageSpaces(user: Identity) {
  const rows = await all<SpaceRow & { workspace_name: string }>(
    `SELECT s.*,w.name workspace_name FROM spaces s JOIN workspaces w ON w.id=s.workspace_id
       JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=?
     WHERE s.deleted_at IS NULL AND COALESCE(s.encrypted,0)=0 AND COALESCE(s.encrypt_titles,0)=0 AND m.role IN ('editor','owner')
     ORDER BY w.name,s.position,s.name`,
    user.id,
  );
  const spaces: { id: string; name: string; icon: string; workspace: string }[] = [];
  for (const space of rows) {
    if ((await isGuest(user, space.workspace_id)) || !writes(await spaceRole(user, space))) continue;
    spaces.push({ id: space.id, name: space.name.slice(0, 80), icon: space.icon || "", workspace: space.workspace_name.slice(0, 40) });
    if (spaces.length >= 200) break;
  }
  return spaces;
}
