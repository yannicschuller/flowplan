// A saved page template as a journal's daily template (#316): its content
// is copied once on choosing it; later edits of the saved template do not
// reach the journal until it is chosen again.
import { z } from "zod";
import { HttpError } from "./auth";
import { requireTemplate } from "./page-templates";
import { instantiateTemplateFiles } from "./template-files";
import { quotaCheckpoint } from "./instance-ops";
import { setJournalTemplate } from "./journal-extras";
import type { Identity, Page } from "./types";

export async function templateFromSaved(user: Identity, journal: Page, templateId: string) {
  // May this person read it: private ones of others, the workspace's for
  // guests and those of spaces one cannot open are refused here.
  const template = await requireTemplate(user, templateId, journal.workspace_id);
  if (template.kind !== "document")
    throw new HttpError(400, "Nur Dokumentvorlagen lassen sich als Tagesvorlage verwenden.");
  // Only the journal's space and the whole workspace (shared instance
  // templates carry no space of this workspace).
  if (template.workspace_id === journal.workspace_id && template.space_id && template.space_id !== journal.space_id)
    throw new HttpError(403, "Vorlage eines anderen Bereichs.");
  // Attachments become files of the journal, like the template's files of a
  // new page (lib/template-files.ts).
  const quota = await quotaCheckpoint(journal.workspace_id);
  const payload = await instantiateTemplateFiles(user, journal.id, template.id, template.payload);
  await quota();
  const { html } = z.object({ html: z.string().max(2_000_000) }).parse(JSON.parse(payload));
  // Through the document schema like every journal template.
  await setJournalTemplate(journal, html);
}
