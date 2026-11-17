// The BookStack import as the routes call it (POST /api/import/bookstack):
// "list" answers with the shelves and books the token sees, "preview"
// reads the chosen ones without downloading files and answers with the
// counts, "import" reads them with images and attachments
// (lib/importers/bookstack-api.ts) and writes them like any other import
// (lib/importers/write.ts), with the import report. The token is an
// argument here and nothing more: never stored, never logged, and no
// message that leaves here carries it.
import { HttpError } from "../auth";
import { jobProgress } from "../background-jobs";
import { maxUploadMbFor } from "../user-limits";
import { bookStackCredentials, listBookStack, readBookStack, scrubToken, type BookStackCounts, type BookStackCredentials, type BookStackOptions, type BookStackSelection } from "./bookstack-api";
import { previewImport, requireSpace, writeImport, type ImportPreview, type ImportResult } from "./write";
import type { Identity } from "../types";

export type BookStackInput = { url?: unknown; tokenId?: unknown; tokenSecret?: unknown } & BookStackSelection;
// The preview and the result with BookStack's own counts: `pages` are its
// pages; shelves, books and chapters become pages as well.
export type BookStackPreview = ImportPreview & Omit<BookStackCounts, "pages" | "tags">;
export type BookStackResult = ImportResult & Omit<BookStackCounts, "pages" | "tags">;

const refuseDemo = (user: Identity) => {
  // The server would fetch for anonymous demo guests.
  if (user.demo) throw new HttpError(403, "Hier nicht verfügbar.");
};

// Errors as they leave: HttpErrors with the token scrubbed out, anything
// else as a general failure (its message could hold anything).
async function scrubbed<T>(credentials: Pick<BookStackCredentials, "tokenId" | "tokenSecret">, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(error.status, scrubToken(error.message, credentials));
    throw new HttpError(500, "Der BookStack-Import ist fehlgeschlagen.");
  }
}
const secrets = (input: BookStackInput) => ({ tokenId: typeof input.tokenId === "string" ? input.tokenId.trim() : "", tokenSecret: typeof input.tokenSecret === "string" ? input.tokenSecret.trim() : "" });

export async function listBookStackFor(user: Identity, workspaceId: string, spaceId: string, input: BookStackInput, test: BookStackOptions = {}) {
  refuseDemo(user);
  await requireSpace(user, workspaceId, spaceId);
  return scrubbed(secrets(input), async () => listBookStack(bookStackCredentials(input), test));
}

export async function importBookStack(user: Identity, workspaceId: string, spaceId: string, input: BookStackInput, options: BookStackOptions & { dryRun: true }): Promise<BookStackPreview>;
export async function importBookStack(user: Identity, workspaceId: string, spaceId: string, input: BookStackInput, options?: BookStackOptions & { dryRun?: false }): Promise<BookStackResult>;
export async function importBookStack(
  user: Identity,
  workspaceId: string,
  spaceId: string,
  input: BookStackInput,
  options: BookStackOptions & { dryRun?: boolean } = {},
): Promise<BookStackPreview | BookStackResult> {
  refuseDemo(user);
  return scrubbed(secrets(input), async () => {
    const credentials = bookStackCredentials(input);
    await requireSpace(user, workspaceId, spaceId);
    const selection = { ...(input.shelves ? { shelves: input.shelves } : {}), ...(input.books ? { books: input.books } : {}) };
    if (input.books && !input.books.length && !input.shelves?.length) throw new HttpError(400, "Bitte wähle mindestens ein Regal oder Buch aus.");
    const { tree, counts } = await readBookStack(credentials, selection, {
      sleep: options.sleep,
      dryRun: !!options.dryRun,
      maxFileBytes: (await maxUploadMbFor(user)) * 1024 * 1024,
    });
    try {
      await jobProgress(0.9);
      const own = { shelves: counts.shelves, books: counts.books, chapters: counts.chapters, images: counts.images, attachments: counts.attachments, links: counts.links };
      if (options.dryRun) return { ...(await previewImport(user, workspaceId, spaceId, tree, "pages")), ...own, pages: counts.pages, tags: counts.tags };
      return { ...(await writeImport(user, workspaceId, spaceId, tree, "pages")), ...own };
    } finally {
      tree.close?.();
    }
  });
}
