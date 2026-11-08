// The writing assistant ("write"): improve, rephrase, shorten, expand,
// simplify, change the tone, translate, turn into a list or table, a free
// instruction for a selection, or a free prompt at the caret (/ki) with the
// page as context. The browser sends the choice and the selected text; the
// prompt is built here (lib/ai/prompts.ts) and the page context loaded here.
// With "links" asked for (and the feature usable), relevant existing pages
// are offered to the model under handles (lib/ai/link-candidates.ts); the
// handles and their pages go to the browser in X-Flowplan-Links, which turns
// them into page links (lib/ai/links.ts). A request for a list of pages also
// sends the titles of further matching pages; list items naming a page
// exactly are linked afterwards (lib/ai/title-links.ts, POST
// /api/ai/links/resolve).
import { z } from "zod";
import { HttpError } from "../auth";
import { one } from "../db";
import { requirePage } from "../permissions";
import { requireRow } from "../row-documents";
import type { Identity } from "../types";
import { aiPageMarkdown } from "./content";
import { databaseContext, databaseNotes } from "./database-context";
import { DATABASES_HEADER, encodeDatabaseNotes } from "./database-note";
import { asksForPageList, encodeLinkTargets, findLinkCandidates } from "./link-candidates";
import { LINKS_HEADER } from "./links";
import { WRITE_ACTION_IDS, WRITE_LANGUAGES, WRITE_TONES, writePrompt, type WriteAction } from "./prompts";
import { isLocalProvider } from "./resolve";
import { aiStreamResponse, requireAi } from "./run";

export const WRITE_LIMITS = {
  // Selected text.
  maxText: 40_000,
  maxInstruction: 4_000,
  // The page as context: smaller for models on the own server.
  contextChars: { local: 8_000, remote: 40_000 },
} as const;

const input = z.object({
  pageId: z.uuid(),
  rowId: z.uuid().optional(),
  action: z.enum(WRITE_ACTION_IDS as [WriteAction, ...WriteAction[]]),
  text: z.string().max(WRITE_LIMITS.maxText).optional(),
  instruction: z.string().max(WRITE_LIMITS.maxInstruction).optional(),
  tone: z.enum(WRITE_TONES.map((t) => t[0]) as [(typeof WRITE_TONES)[number][0]]).optional(),
  language: z.enum(WRITE_LANGUAGES.map((l) => l[0]) as [(typeof WRITE_LANGUAGES)[number][0]]).optional(),
  // The page as context (the free prompt).
  context: z.boolean().optional(),
  // Link relevant existing pages in the answer.
  links: z.boolean().optional(),
  // A quick capture (#172): its shorthand (#tag @person !priority dates)
  // stays as typed (lib/ai/prompts.ts CAPTURE_RULES).
  capture: z.boolean().optional(),
  locale: z.enum(["de", "en", "fr", "zh"]).default("de"),
});

// POST /api/ai/write → the answer as a text stream (lib/ai/run.ts).
export async function aiWriteResponse(user: Identity, raw: unknown, signal: AbortSignal): Promise<Response> {
  const b = input.parse(raw);
  if (b.action !== "prompt" && !b.text?.trim()) throw new HttpError(400, "Bitte zuerst Text auswählen.");
  if ((b.action === "custom" || b.action === "prompt") && !b.instruction?.trim())
    throw new HttpError(400, "Bitte beschreiben, was die KI tun soll.");
  const page = await requirePage(user, b.pageId);
  if (b.rowId) await requireRow(user, b.pageId, b.rowId);
  const options = { workspaceId: page.workspace_id, pageId: page.id, rowId: b.rowId, signal };
  // The selection is page content too: refused when the AI may not read it.
  const resolved = await requireAi(user, "write", options);
  const local = resolved.config.kind === "ollama" || isLocalProvider(resolved.config);
  let context: { title: string; markdown: string } | null = null;
  if (b.context && b.action === "prompt") {
    const limit = local ? WRITE_LIMITS.contextChars.local : WRITE_LIMITS.contextChars.remote;
    const markdown = await aiPageMarkdown(user, page, b.rowId);
    context = { title: page.title, markdown: markdown.length > limit ? markdown.slice(0, limit) + "\n\n[…]" : markdown };
  }
  // Records of databases the instruction names or links (#80) – within the
  // same budget as the page context. Links in the open page count when the
  // page goes along as context and the instruction speaks of a table.
  const data =
    b.action === "prompt" || b.action === "custom"
      ? (await databaseContext(user, {
          workspaceId: page.workspace_id,
          instruction: b.instruction || "",
          texts: [b.text],
          document: b.context && b.action === "prompt" ? (await storedHtml(page.id, b.rowId)) : null,
          maxChars: local ? WRITE_LIMITS.contextChars.local : WRITE_LIMITS.contextChars.remote,
        }))
      : [];
  // Pages to link: found with the instruction, the selection and the page's title.
  const links = b.links
    ? await findLinkCandidates(user, {
        workspaceId: page.workspace_id,
        pageId: page.id,
        query: [b.instruction, b.text, page.title].filter(Boolean).join("\n"),
        local,
        // "Liste alle Seiten zu …": titles of further pages go along (#134).
        list: (b.action === "prompt" || b.action === "custom") && asksForPageList(b.instruction || ""),
        semantic: resolved.source === "instance",
        signal,
      })
    : null;
  const response = await aiStreamResponse(
    user,
    "write",
    writePrompt({
      action: b.action,
      text: b.text,
      instruction: b.instruction,
      tone: b.tone,
      language: b.language,
      page: context,
      locale: b.locale,
      links: links?.prompt,
      index: links?.index,
      databases: data.length ? data.map((d) => d.block).join("\n\n") : null,
      capture: b.capture,
    }),
    options,
  );
  if (links?.targets.length) response.headers.set(LINKS_HEADER, encodeLinkTargets(links.targets));
  if (data.length) response.headers.set(DATABASES_HEADER, encodeDatabaseNotes(databaseNotes(data)));
  return response;
}

// The open page's or record's stored document (its links to databases).
async function storedHtml(pageId: string, rowId?: string) {
  return rowId
    ? (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rowId))?.html || null
    : (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))?.html || null;
}
