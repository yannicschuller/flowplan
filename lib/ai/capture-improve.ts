// "Text verbessern" for the desktop app's capture window (#172): its one
// field – with shorthand such as "#kunde @anna !hoch morgen 15 Uhr" – goes
// through the writing assistant's "improve" (lib/ai/prompts.ts, the rules
// CAPTURE_RULES keep the shorthand as typed). The answer comes back as JSON
// with the shorthand the model changed or dropped ("lost"); the window shows
// it as a preview to take or not – nothing is saved here.
//
//   POST /api/ai/capture/improve { pageId, text, today, locale }
//     → { text, lost }                 the instance's AI
//   … with device: true → { device }  the prompt for the Mac's model
//   … with answer: "…"  → { text, lost } that answer checked, no AI run
//
// pageId is the capture's target (the inbox database, a database, a page or
// the journal); the AI must be allowed to read it, as for the editor. Rate
// limits and quotas are the writing assistant's (lib/ai/run.ts).
import { z } from "zod";
import { HttpError } from "../auth";
import { ct } from "../content-locale";
import { requirePage } from "../permissions";
import type { Identity } from "../types";
import { lostCaptureTokens } from "../capture-improve";
import { AI_BLOCKED_MESSAGE, aiMayRead } from "./access";
import { deviceWriteFits, deviceWritePrompt } from "./device-prompts";
import { writePrompt, type WriteRequest } from "./prompts";
import { deviceGate, resolveAi } from "./resolve";
import { aiComplete, requireAi } from "./run";

export const IMPROVE_LIMITS = { text: 20_000 } as const;

// Which way "Text verbessern" can run for this person, or null (the capture
// window shows no button then).
export async function captureImproveMode(user: Identity): Promise<{ server: boolean; device: boolean } | null> {
  const server = (await resolveAi(user, "write")).ok;
  const device = !(await deviceGate(user, "write"));
  return server || device ? { server, device } : null;
}

const input = z.object({
  pageId: z.uuid(),
  text: z.string().max(IMPROVE_LIMITS.text),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locale: z.enum(["de", "en", "fr", "zh"]).default("de"),
  device: z.boolean().default(false),
  // The Mac's answer, to be checked.
  answer: z.string().max(IMPROVE_LIMITS.text * 2).optional(),
});

// The answer without the code block or quotes a model sometimes adds.
export function cleanImproved(answer: string) {
  let text = answer.replace(/\r\n?/g, "\n").trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  if (/^(["„“»])[\s\S]*["“”«]$/.test(text) && text.length > 2) text = text.slice(1, -1).trim();
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").slice(0, IMPROVE_LIMITS.text);
}

export async function improveCapture(user: Identity, raw: unknown, signal?: AbortSignal) {
  const b = input.parse(raw);
  const text = b.text.trim();
  if (!text) throw new HttpError(400, ct("Bitte zuerst Text eingeben.", "Please enter some text first."));
  const page = await requirePage(user, b.pageId);
  const checked = (answer: string) => {
    const improved = cleanImproved(answer);
    return { text: improved, lost: lostCaptureTokens(text, improved, { today: b.today, locale: b.locale }) };
  };
  const request: WriteRequest = { action: "improve", text, locale: b.locale, capture: true };
  if (b.device || b.answer !== undefined) {
    const gate = await deviceGate(user, "write", { workspaceId: page.workspace_id });
    if (gate) throw new HttpError(403, ct("KI auf dem Gerät ist ausgeschaltet.", "On-device AI is switched off."));
    if (!(await aiMayRead(user, page.id))) throw new HttpError(403, AI_BLOCKED_MESSAGE);
    if (b.answer !== undefined) return checked(b.answer);
    if (!deviceWriteFits(request)) throw new HttpError(413, ct("Der Text ist zu lang für die KI auf diesem Gerät.", "The text is too long for the on-device AI."));
    return { device: deviceWritePrompt(request) };
  }
  const options = { workspaceId: page.workspace_id, pageId: page.id, signal };
  await requireAi(user, "write", options);
  return checked(await aiComplete(user, "write", writePrompt(request), options));
}
