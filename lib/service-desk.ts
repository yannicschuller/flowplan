// Customer portal (service desk): whoever sends a form with the portal
// switched on gets a private link to their request. There they see the
// status (the properties the team chose), their answers and a conversation
// with the team; the team answers from the record. Without an account – the
// link is the key, like a share link.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { requireRow } from "./row-documents";
import { cellText } from "./cell-text";
import { formConfigSchema, orderedFormFields } from "./form-settings";
import { contentLocale } from "./content-locale";
import { translate, isLocale, type Locale } from "./i18n";
import { queueCustomerMail } from "./mail";
import type { Field, Identity, Page } from "./types";

type Ticket = { token: string; row_id: string; page_id: string; email: string | null; locale: string; created_at: number };
type Message = { id: string; author_id: string | null; author_name: string; body: string; created_at: number };

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const ticketUrl = (token: string) => `${appUrl()}/ticket/${token}`;
export const messageBody = z.string().trim().min(1).max(5000);
const fieldsOf = (pageId: string): Field[] =>
  JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]");
// The record's title: its first property.
const rowTitle = (fields: Field[], cells: Record<string, unknown>) => cellText(cells[fields[0]?.id || "title"]).slice(0, 200);
function display(field: Field, value: unknown, locale: Locale) {
  if (field.type === "checkbox") return value ? "✓" : "–";
  if (field.type === "checklist" && Array.isArray(value))
    return value.map((item: { text?: string; done?: boolean }) => `${item.done ? "☑" : "☐"} ${item.text || ""}`).join("\n");
  if (field.type === "files") {
    const count = Array.isArray(value) ? value.length : 0;
    return count ? translate(locale)(`${count} ${count === 1 ? "Datei" : "Dateien"}`, `${count} ${count === 1 ? "file" : "files"}`) : "";
  }
  return cellText(value);
}

// After a form answer was saved (inside the same transaction).
export function createTicket(input: { pageId: string; rowId: string; title: string; fields: Field[]; cells: Record<string, unknown> }) {
  const token = randomBytes(24).toString("base64url");
  const locale = contentLocale();
  // The first e-mail question answered is where the link goes.
  const email =
    input.fields
      .filter((f) => f.type === "email")
      .map((f) => String(input.cells[f.id] || "").trim())
      .find((v) => /^[^\s@]+@[^\s@]+$/.test(v)) || null;
  run(
    "INSERT INTO tickets(token,row_id,page_id,email,locale,created_at) VALUES(?,?,?,?,?,?)",
    token,
    input.rowId,
    input.pageId,
    email,
    locale,
    Date.now(),
  );
  let mailed = false;
  if (email) {
    const t = translate(locale);
    mailed = queueCustomerMail({
      to: email,
      locale,
      subject: t(`Deine Anfrage: ${input.title}`, `Your request: ${input.title}`),
      title: t("Deine Anfrage ist angekommen", "Your request has arrived"),
      lines: [
        t(
          `Danke, deine Anfrage über „${input.title}“ ist gespeichert.`,
          `Thank you, your request through “${input.title}” has been saved.`,
        ),
        t(
          "Unter diesem Link siehst du jederzeit den Stand und kannst dem Team antworten. Behalte den Link für dich – wer ihn hat, kann die Anfrage sehen.",
          "At this link you can see its status at any time and reply to the team. Keep the link to yourself – anyone who has it can see the request.",
        ),
      ],
      label: t("Anfrage ansehen", "View request"),
      url: ticketUrl(token),
    });
  }
  return { token, mailed };
}

function ticketRecord(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "Anfrage nicht gefunden.");
  const ticket = one<Ticket & { cells: string; title: string; config: string; enabled: number }>(
    "SELECT t.*,r.cells,p.title,f.config,f.enabled FROM tickets t JOIN rows r ON r.id=t.row_id AND r.page_id=t.page_id JOIN pages p ON p.id=t.page_id AND p.deleted_at IS NULL JOIN forms f ON f.page_id=t.page_id WHERE t.token=?",
    token,
  );
  if (!ticket || !ticket.enabled) throw new HttpError(404, "Anfrage nicht gefunden.");
  const config = formConfigSchema.parse(JSON.parse(ticket.config));
  // Switching the portal off closes every link.
  if (!config.portal) throw new HttpError(404, "Anfrage nicht gefunden.");
  return { ticket, config };
}
const messages = (rowId: string) =>
  all<Message>("SELECT id,author_id,author_name,body,created_at FROM ticket_messages WHERE row_id=? ORDER BY created_at,id", rowId);

// What the customer sees.
export function customerTicket(token: string) {
  const { ticket, config } = ticketRecord(token);
  const locale: Locale = isLocale(contentLocale()) ? contentLocale() : "de";
  const fields = fieldsOf(ticket.page_id);
  const cells = JSON.parse(ticket.cells) as Record<string, unknown>;
  const show = (f: Field) => ({ id: f.id, name: f.name, type: f.type, value: display(f, cells[f.id], locale) });
  // Only public property types; people and relations stay inside.
  const status = config.portalFields
    .map((fid) => fields.find((f) => f.id === fid))
    .filter((f): f is Field => !!f && !["person", "relation", "created_by", "updated_by", "files"].includes(f.type))
    .map(show);
  return {
    title: config.title || ticket.title,
    subject: rowTitle(fields, cells),
    created_at: ticket.created_at,
    status,
    answers: orderedFormFields(fields, config, false).map(show).filter((a) => a.value !== ""),
    messages: messages(ticket.row_id).map((m) => ({
      id: m.id,
      team: !!m.author_id,
      name: m.author_id ? m.author_name : "",
      body: m.body,
      created_at: m.created_at,
    })),
  };
}

// A reply from the customer: notifies the people who handle the record.
export function customerReply(token: string, input: unknown) {
  const { ticket } = ticketRecord(token);
  const body = messageBody.parse(z.object({ body: z.string() }).parse(input).body);
  const recent =
    one<{ n: number }>(
      "SELECT count(*) n FROM ticket_messages WHERE row_id=? AND author_id IS NULL AND created_at>?",
      ticket.row_id,
      Date.now() - 3600_000,
    )?.n || 0;
  if (recent >= 20) throw new HttpError(429, "Zu viele Nachrichten. Bitte später erneut versuchen.");
  run(
    "INSERT INTO ticket_messages(id,row_id,author_id,author_name,body,created_at) VALUES(?,?,NULL,'',?,?)",
    id(),
    ticket.row_id,
    body,
    Date.now(),
  );
  const page = one<Page>("SELECT * FROM pages WHERE id=?", ticket.page_id)!;
  const fields = fieldsOf(page.id);
  const cells = JSON.parse(ticket.cells) as Record<string, unknown>;
  // People on the record, whoever answered before, and the database's owner.
  const people = fields
    .filter((f) => f.type === "person")
    .flatMap((f) => (Array.isArray(cells[f.id]) ? (cells[f.id] as unknown[]) : [cells[f.id]]))
    .filter((v): v is string => typeof v === "string");
  const answered = all<{ author_id: string }>(
    "SELECT DISTINCT author_id FROM ticket_messages WHERE row_id=? AND author_id IS NOT NULL",
    ticket.row_id,
  ).map((m) => m.author_id);
  const subject = rowTitle(fields, cells) || page.title;
  for (const uid of new Set([...people, ...answered, page.created_by].filter(Boolean) as string[])) {
    const member = one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", uid);
    if (!member || !pageRole({ ...member, groups: [], isAdmin: false } as Identity, page)) continue;
    if (hiddenRowIds({ ...member, groups: [], isAdmin: false } as Identity, page).has(ticket.row_id)) continue;
    run(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'guest')",
      id(),
      uid,
      `Neue Kundenantwort zu „${subject}“`,
      page.id,
      ticket.row_id,
    );
  }
  return customerTicket(token);
}

// The conversation inside the record, for the team.
export function teamThread(user: Identity, pageId: string, rowId: string) {
  requireRow(user, pageId, rowId);
  const ticket = one<Ticket>("SELECT * FROM tickets WHERE row_id=? AND page_id=?", rowId, pageId);
  if (!ticket) return { ticket: null, messages: [] };
  const page = requirePage(user, pageId);
  const canWrite = pageRole(user, page) === "owner" || pageRole(user, page) === "editor";
  return {
    ticket: {
      email: ticket.email,
      created_at: ticket.created_at,
      // Only people who may answer can pass the link on.
      url: canWrite ? ticketUrl(ticket.token) : null,
    },
    messages: messages(rowId).map((m) => ({ ...m, team: !!m.author_id })),
  };
}

// A reply from the team: e-mailed to the customer in their language.
export function teamReply(user: Identity, pageId: string, rowId: string, input: unknown) {
  const { row } = requireRow(user, pageId, rowId, true);
  const ticket = one<Ticket>("SELECT * FROM tickets WHERE row_id=? AND page_id=?", rowId, pageId);
  if (!ticket) throw new HttpError(404, "Zu diesem Eintrag gibt es keine Kundenanfrage.");
  const body = messageBody.parse(input);
  run(
    "INSERT INTO ticket_messages(id,row_id,author_id,author_name,body,created_at) VALUES(?,?,?,?,?,?)",
    id(),
    rowId,
    user.id,
    user.name || "Team",
    body,
    Date.now(),
  );
  if (ticket.email) {
    const locale: Locale = isLocale(ticket.locale) ? ticket.locale : "de";
    const t = translate(locale);
    const fields = fieldsOf(pageId);
    const cells = typeof row.cells === "string" ? JSON.parse(row.cells) : row.cells;
    const subject = rowTitle(fields, cells as Record<string, unknown>);
    queueCustomerMail({
      to: ticket.email,
      locale,
      subject: t(`Neue Antwort zu deiner Anfrage${subject ? ` „${subject}“` : ""}`, `New reply to your request${subject ? ` “${subject}”` : ""}`),
      title: t("Neue Antwort auf deine Anfrage", "New reply to your request"),
      lines: [body.length > 1500 ? `${body.slice(0, 1500)} …` : body],
      label: t("Anfrage ansehen und antworten", "View and reply"),
      url: ticketUrl(ticket.token),
    });
  }
  return teamThread(user, pageId, rowId);
}
