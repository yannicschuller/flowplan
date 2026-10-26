// AI suggestion for quick capture (the desktop app's capture window): from
// the text, which database it belongs in, a title and property values –
// shown as chips to accept or ignore, never applied by themselves.
//
// Two ways, decided here per person:
//   - the instance's AI ("KI-Aktionen" / "AI actions": proposals that are
//     only applied after confirming): POST /api/ai/capture/suggest;
//   - Apple's on-device model on a Mac (the desktop app's helper,
//     device-ai.js): the server builds the prompt (POST …/suggest with
//     device: true), the Mac answers it, and the answer is checked here
//     (POST /api/ai/capture/check) – the text never reaches the server's AI.
// Off when an administrator or the person switched AI (or AI actions) off.
// Only the names of databases and properties the AI may read are sent,
// never their content; "Für KI gesperrt" databases are left out.
import { z } from "zod";
import { HttpError } from "../auth";
import { ct } from "../content-locale";
import { all, one } from "../db";
import type { Identity, Page } from "../types";
import { captureTargetList } from "../mobile-widgets";
import { findMember, type CaptureMember, type CaptureProperty } from "../capture-parse";
import { aiMayRead } from "./access";
import { aiJson } from "./json";
import { deviceGate, resolveAi } from "./resolve";
import { requireAi } from "./run";
import { featureAllowed, instanceAiSettings, userAiSettings } from "./settings";

export const SUGGEST_LIMITS = { text: 4000, databases: 25, deviceDatabases: 8, options: 20, properties: 12 } as const;

// Which way a suggestion can be made for this person, or null.
export function captureSuggestMode(user: Identity): { server: boolean; device: boolean; prefer: "server" | "device" } | null {
  const server = resolveAi(user, "actions").ok;
  const own = userAiSettings(user.id);
  const device = !deviceGate(user, "write") && featureAllowed(instanceAiSettings(), "actions") && own.features.actions !== false;
  if (!server && !device) return null;
  return { server, device, prefer: device && (own.device !== "fallback" || !server) ? "device" : "server" };
}

type Candidate = { id: string; name: string; workspaceId: string; properties: CaptureProperty[] };
// Lazy: lib/desktop-capture imports this file for captureSuggestMode.
async function propertiesOf(user: Identity, page: Page) {
  const { captureProperties } = await import("../desktop-capture");
  return captureProperties(user, page);
}
async function candidates(user: Identity, max: number, only?: string[]): Promise<Candidate[]> {
  const list: Candidate[] = [];
  for (const t of captureTargetList(user)) {
    if (t.kind !== "database" || (only && !only.includes(t.id)) || !aiMayRead(user, t.id)) continue;
    const page = one<Page>("SELECT * FROM pages WHERE id=?", t.id);
    if (!page) continue;
    const properties = (await propertiesOf(user, page)).filter((p) => p.type !== "files").slice(0, SUGGEST_LIMITS.properties);
    list.push({ id: t.id, name: t.name, workspaceId: page.workspace_id, properties: properties.map((p) => ({ ...p, options: p.options?.slice(0, SUGGEST_LIMITS.options) })) });
    if (list.length >= max) break;
  }
  return list;
}

const SYSTEM = [
  "Du ordnest eine schnell erfasste Notiz ein. Wähle aus dem Katalog die passendste Datenbank,",
  "einen kurzen Titel (höchstens 80 Zeichen, in der Sprache der Notiz) und Werte für Eigenschaften,",
  "die die Notiz eindeutig nennt. Nur Eigenschaften und Optionen aus dem Katalog; Daten als YYYY-MM-DD;",
  "Personen mit ihrem Namen. Antworte nur mit JSON:",
  '{"targetId":"<id>","title":"…","fields":[{"name":"<Eigenschaft>","value":"<Wert>"}]}',
].join(" ");
const value = z.union([z.string().max(300), z.array(z.string().max(300)).max(20), z.number(), z.boolean(), z.null()]);
// The device model answers fields as a list (its schemas need named properties).
const answerSchema = z.object({
  targetId: z.string().max(100),
  title: z.string().max(300).default(""),
  fields: z
    .union([z.record(z.string().max(200), value), z.array(z.object({ name: z.string().max(200), value })).max(30).transform((list) => Object.fromEntries(list.map((f) => [f.name, f.value])))])
    .default({}),
});
export const suggestInput = z.object({
  text: z.string().trim().min(3).max(SUGGEST_LIMITS.text),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // The databases to choose from (the capture window's list); all when absent.
  targets: z.array(z.uuid()).max(50).optional(),
  device: z.boolean().default(false),
});

function catalogPrompt(list: Candidate[], text: string, today: string) {
  const catalog = list.map((c) => ({ id: c.id, name: c.name, properties: c.properties.map((p) => ({ name: p.name, type: p.type, ...(p.options ? { options: p.options } : {}) })) }));
  return `Heute ist ${today}.\nKatalog (JSON):\n${JSON.stringify(catalog)}\n\nNotiz:\n<notiz>\n${text}\n</notiz>`;
}

// The model's answer as checked chips: a known database, a title, and only
// values that fit the property (an option it has, a real day, a member).
export function checkSuggestion(list: Candidate[], members: (workspaceId: string) => CaptureMember[], raw: unknown) {
  const answer = answerSchema.parse(raw);
  const target = list.find((c) => c.id === answer.targetId) || null;
  const title = answer.title.replace(/\s+/g, " ").trim().slice(0, 120);
  const fields: { id: string; name: string; value: unknown; label: string }[] = [];
  if (target)
    for (const [name, value] of Object.entries(answer.fields)) {
      const p = target.properties.find((f) => f.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase() || f.id === name);
      if (!p || value === null || value === "") continue;
      const option = (v: unknown) => p.options?.find((o) => o.toLocaleLowerCase() === String(v).trim().toLocaleLowerCase());
      if (p.type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))) {
        const day = value.slice(0, 10);
        if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day) fields.push({ id: p.id, name: p.name, value: day, label: day });
      } else if (p.type === "select" && option(value)) fields.push({ id: p.id, name: p.name, value: option(value), label: option(value)! });
      else if (p.type === "multiselect") {
        const values = (Array.isArray(value) ? value : String(value).split(",")).map(option).filter((v): v is string => !!v);
        if (values.length) fields.push({ id: p.id, name: p.name, value: [...new Set(values)], label: [...new Set(values)].join(", ") });
      } else if (p.type === "person") {
        const member = findMember(members(target.workspaceId), String(value));
        if (member) fields.push({ id: p.id, name: p.name, value: member.id, label: member.name || member.email });
      } else if (p.type === "url" && typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim())) fields.push({ id: p.id, name: p.name, value: value.trim(), label: value.trim() });
    }
  return { suggestion: { targetId: target?.id || null, targetName: target?.name || null, title, fields } };
}
const membersOf = (workspaceId: string) =>
  all<CaptureMember>("SELECT u.id,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND COALESCE(u.disabled,0)=0 LIMIT 500", workspaceId);

// The server's AI answers – or, with device: true, the prompt for the Mac.
export async function suggestCapture(user: Identity, raw: unknown, signal?: AbortSignal) {
  const input = suggestInput.parse(raw);
  const mode = captureSuggestMode(user);
  if (!mode) throw new HttpError(403, ct("KI ist ausgeschaltet.", "AI is switched off."));
  if (input.device) {
    if (!mode.device) throw new HttpError(403, ct("KI auf dem Gerät ist ausgeschaltet.", "On-device AI is switched off."));
    const list = await candidates(user, SUGGEST_LIMITS.deviceDatabases, input.targets);
    if (!list.length) throw new HttpError(409, ct("Keine Datenbank, in die erfasst werden kann.", "No database to capture into."));
    return {
      device: {
        instructions: SYSTEM,
        prompt: catalogPrompt(list, input.text.slice(0, 2000), input.today),
        schema: {
          type: "object",
          properties: {
            targetId: { type: "string", enum: list.map((c) => c.id) },
            title: { type: "string" },
            fields: { type: "array", maxItems: 8, items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"] } },
          },
          required: ["targetId", "title", "fields"],
        },
        temperature: 0.2,
        maxTokens: 400,
      },
    };
  }
  if (!mode.server) throw new HttpError(403, ct("KI ist ausgeschaltet.", "AI is switched off."));
  const list = await candidates(user, SUGGEST_LIMITS.databases, input.targets);
  if (!list.length) throw new HttpError(409, ct("Keine Datenbank, in die erfasst werden kann.", "No database to capture into."));
  requireAi(user, "actions", { workspaceId: list[0].workspaceId });
  const answer = await aiJson(user, "actions", { system: SYSTEM, messages: [{ role: "user", content: catalogPrompt(list, input.text, input.today) }], maxTokens: 600 }, answerSchema, {
    workspaceId: list[0].workspaceId,
    signal,
  });
  return checkSuggestion(list, membersOf, answer);
}

// The Mac's answer to the device prompt, checked like the server's.
export async function checkDeviceSuggestion(user: Identity, raw: unknown) {
  const input = z.object({ answer: z.unknown(), targets: z.array(z.uuid()).max(50).optional() }).parse(raw);
  const mode = captureSuggestMode(user);
  if (!mode?.device) throw new HttpError(403, ct("KI auf dem Gerät ist ausgeschaltet.", "On-device AI is switched off."));
  const list = await candidates(user, SUGGEST_LIMITS.deviceDatabases, input.targets);
  return checkSuggestion(list, membersOf, input.answer);
}
