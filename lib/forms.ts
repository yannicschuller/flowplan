import { z } from "zod";
import { hiddenRowIds, visibleRows } from "./row-access";
import { fieldWriteMessage, publicWritable } from "./field-access";
import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { pageRole, requireMember, requirePage } from "./permissions";
import { cellText } from "./cell-text";
import {
  formConfigSchema,
  orderedFormFields,
  validateFormValues,
  type FormConfig,
} from "./form-settings";
import { answerText, answersByName, fillPlaceholders } from "./form-logic";
import type { Identity, Field, Page } from "./types";
import { emitWebhook } from "./webhooks";
import { rowCreated } from "./automations";
import { contentLocale, ct } from "./content-locale";
import { translate } from "./i18n";
import { mailConfig, queueFormConfirmationMail } from "./mail";
import { allow, mailAllowed } from "./action-limits";
export function formSettings(pageId: string) {
  const raw = one<{
    token: string;
    enabled: number;
    internal: number;
    anonymous: number;
    config: string;
  }>("SELECT * FROM forms WHERE page_id=?", pageId);
  return raw
    ? { ...raw, config: formConfigSchema.parse(JSON.parse(raw.config)) }
    : null;
}
export function getForm(token: string, user: Identity | null) {
  const f = one<{
    page_id: string;
    title: string;
    workspace_id: string;
    internal: number;
    anonymous: number;
    config: string;
  }>(
    "SELECT f.*,p.title,p.workspace_id FROM forms f JOIN pages p ON p.id=f.page_id WHERE f.token=? AND f.enabled=1 AND p.deleted_at IS NULL",
    token,
  );
  if (!f) throw new HttpError(404, "Formular nicht gefunden.");
  if (f.internal) {
    if (!user)
      throw new HttpError(
        401,
        "Bitte melde dich an, um dieses Formular auszufüllen.",
      );
    requireMember(user, f.workspace_id);
  }
  if (!f.anonymous && !user)
    throw new HttpError(401, "Dieses Formular erfordert eine Anmeldung.");
  const fields: Field[] = JSON.parse(
      one<{ fields: string }>(
        "SELECT fields FROM databases WHERE page_id=?",
        f.page_id,
      )!.fields,
    ),
    config = formConfigSchema.parse(JSON.parse(f.config));
  const internal = !!f.internal && !!user;
  // Properties with a read or write rule are never asked in a form
  // (lib/field-access.ts).
  const questions = orderedFormFields(fields, config, internal).filter((q) =>
    publicWritable(q, fields),
  );
  return {
    ...f,
    config,
    title: config.title || f.title,
    fields: questions,
    // Choices for people and relations, only for signed-in members.
    members: internal
      ? all<{ id: string; name: string }>(
          "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=? AND u.disabled=0 ORDER BY u.name",
          f.workspace_id,
        )
      : [],
    related: internal ? relationChoices(user!, questions) : {},
  };
}
function relationChoices(user: Identity, fields: Field[]) {
  const related: Record<string, { id: string; cells: { title: string } }[]> =
    {};
  for (const f of fields) {
    if (f.type !== "relation" || !f.relationPage || related[f.relationPage])
      continue;
    const target = one<Page>(
      "SELECT * FROM pages WHERE id=? AND deleted_at IS NULL",
      f.relationPage,
    );
    if (!target || !pageRole(user, target)) continue;
    const title =
      (
        JSON.parse(
          one<{ fields: string }>(
            "SELECT fields FROM databases WHERE page_id=?",
            target.id,
          )?.fields || "[]",
        ) as Field[]
      )[0]?.id || "title";
    related[target.id] = visibleRows(
      user,
      target,
      all<{ id: string; cells: string; access: string; created_by: string }>(
        "SELECT id,cells,access,created_by FROM rows WHERE page_id=? ORDER BY position LIMIT 1000",
        target.id,
      ),
    ).map((r) => ({
      id: r.id,
      cells: { title: cellText(JSON.parse(r.cells)[title]) },
    }));
  }
  return related;
}
// Options: `confirm: false` when the caller sends the confirmation e-mail
// itself (with the customer portal's link); `sender` tells visitors apart
// for the e-mail limits (account or address).
export function saveFormSubmission(
  pageId: string,
  user: Identity | null,
  values: Record<string, unknown>,
  memberSubmission = false,
  options: { confirm?: boolean; sender?: string } = {},
) {
  const form = formSettings(pageId),
    config = form?.config || formConfigSchema.parse({});
  const internal = memberSubmission || (!!form?.internal && !!user);
  const fields: Field[] = JSON.parse(
    one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      pageId,
    )!.fields,
  );
  for (const key of Object.keys(values)) {
    const f = fields.find((f) => f.id === key);
    if (f && !publicWritable(f, fields))
      throw new HttpError(403, fieldWriteMessage(f));
  }
  const result = validateFormValues(fields, config, values, internal);
  if (Object.keys(result.errors).length)
    throw new HttpError(400, Object.values(result.errors).join(" "));
  const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId)!;
  for (const f of fields) {
    const value = result.cells[f.id];
    if (value === undefined || value === null || value === "") continue;
    if (
      f.type === "person" &&
      !one(
        "SELECT 1 FROM members WHERE workspace_id=? AND user_id=?",
        page.workspace_id,
        String(value),
      )
    )
      throw new HttpError(400, `${f.name}: Mitglied nicht gefunden.`);
    if (f.type === "relation" && Array.isArray(value) && value.length) {
      if (!f.relationPage || !user)
        throw new HttpError(400, `${f.name}: Verknüpfung nicht möglich.`);
      requirePage(user, f.relationPage);
      for (const rid of value)
        if (
          !one(
            "SELECT 1 FROM rows WHERE id=? AND page_id=?",
            rid,
            f.relationPage,
          )
        )
          throw new HttpError(400, `${f.name}: Eintrag nicht gefunden.`);
    }
    // Attached files must belong to this database.
    if (f.type === "files" && Array.isArray(value))
      for (const url of value)
        if (
          !one(
            "SELECT 1 FROM files WHERE id=? AND page_id=?",
            String(url).split("/").pop() || "",
            pageId,
          )
        )
          throw new HttpError(400, `${f.name}: Datei nicht gefunden.`);
  }
  const rid = id();
  run(
    "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
    rid,
    pageId,
    JSON.stringify(result.cells),
    Date.now(),
    form?.anonymous ? null : user?.id || null,
    form?.anonymous ? null : user?.id || null,
  );
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
  // Survey answers without a title get a running one ("Antwort 12").
  const titleField = fields[0];
  let cells = result.cells;
  if (config.survey?.enabled && titleField?.type === "text" && !result.cells[titleField.id]) {
    const number = one<{ number: number }>("SELECT number FROM rows WHERE id=?", rid)?.number;
    if (number) {
      cells = { ...result.cells, [titleField.id]: `${ct("Antwort", "Response")} ${number}` };
      run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify(cells), rid);
    }
  }
  // A sent answer replaces the person's saved draft.
  if (user) run("DELETE FROM form_drafts WHERE page_id=? AND user_id=?", pageId, user.id);
  notifyTeam(page, config, rid);
  const confirmed =
    options.confirm !== false &&
    confirmFormAnswer(pageId, user, result.cells, { sender: options.sender ?? user?.id ?? "", anonymous: !!form?.anonymous });
  // Automations: "a new record arrives through a form".
  rowCreated(user, page, rid, true);
  const workspace = one<{ workspace_id: string }>("SELECT workspace_id FROM pages WHERE id=?", pageId);
  if (workspace) {
    const payload = { pageId, rowId: rid, cells: result.cells, anonymous: !!form?.anonymous };
    emitWebhook(workspace.workspace_id, "form.submitted", payload);
    emitWebhook(workspace.workspace_id, "row.created", payload);
  }
  return { id: rid, cells, confirmed };
}

// Members chosen in the form settings hear about each new answer (kind
// "guest", like guest comments and records) – if they can see the record.
function notifyTeam(page: Page, config: FormConfig, rowId: string) {
  if (!config.notifyMembers.length) return;
  const title = config.title || page.title;
  for (const uid of new Set(config.notifyMembers)) {
    const member = one<Identity>(
      "SELECT u.* FROM users u JOIN members m ON m.user_id=u.id AND m.workspace_id=? WHERE u.id=? AND u.disabled=0",
      page.workspace_id,
      uid,
    );
    if (!member) continue;
    const who = { ...member, groups: [], isAdmin: false } as Identity;
    if (!pageRole(who, page) || hiddenRowIds(who, page).has(rowId)) continue;
    run(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'guest')",
      id(),
      uid,
      `Neue Antwort über „${title.slice(0, 200)}“`,
      page.id,
      rowId,
    );
  }
}

const HOUR = 3_600_000;
// The confirmation e-mail: the form's text, the answers the person gave
// (only asked questions, no internal properties) and the customer portal's
// link. It goes to the first e-mail question answered – or, in forms that
// are not anonymous, to the signed-in person's address. Limited per
// recipient, per sender and per form, since the text partly comes from the
// person answering. Returns whether a mail was queued.
export function confirmFormAnswer(
  pageId: string,
  user: Identity | null,
  cells: Record<string, unknown>,
  options: { sender?: string; anonymous?: boolean; ticketUrl?: string } = {},
) {
  const form = formSettings(pageId);
  const config = form?.config;
  if (!config?.confirmation.enabled || !mailConfig()) return false;
  const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (!page) return false;
  const fields: Field[] = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]");
  // People and relations never appear; they are internal.
  const questions = orderedFormFields(fields, config, false);
  const typed = questions
    .filter((f) => f.type === "email")
    .map((f) => String(cells[f.id] ?? "").trim())
    .find((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  const anonymous = options.anonymous ?? !!form?.anonymous;
  const to = typed || (!anonymous && user?.email ? user.email : "");
  if (!to) return false;
  if (!allow(`form-confirm:${pageId}`, 300, HOUR)) return false;
  if (options.sender && !allow(`form-confirm-from:${options.sender}`, 10, HOUR)) return false;
  if (!mailAllowed(to)) return false;
  const locale = contentLocale();
  const t = translate(locale);
  const title = config.title || page.title;
  const answer = answersByName(questions, cells);
  const fill = (text: string) => fillPlaceholders(text, answer);
  const answers = questions.flatMap((f) => {
    const value = cells[f.id];
    if (f.type === "files") {
      const count = Array.isArray(value) ? value.length : 0;
      return count ? [{ question: f.name, answer: t(`${count} ${count === 1 ? "Datei" : "Dateien"}`, `${count} ${count === 1 ? "file" : "files"}`) }] : [];
    }
    const text = answerText(value);
    return text ? [{ question: f.name, answer: text.slice(0, 2000) }] : [];
  });
  const message = config.confirmation.message.trim()
    ? fill(config.confirmation.message)
    : t(`Danke, deine Antwort über „${title}“ ist angekommen.`, `Thank you, your answer through “${title}” has arrived.`);
  const lines = message.split(/\n\s*\n/).map((l) => l.trim()).filter(Boolean);
  if (options.ticketUrl)
    lines.push(
      t(
        "Unter dem Link unten siehst du jederzeit den Stand und kannst dem Team antworten. Behalte den Link für dich – wer ihn hat, kann die Anfrage sehen.",
        "At the link below you can see the status at any time and reply to the team. Keep the link to yourself – anyone who has it can see the request.",
      ),
    );
  return queueFormConfirmationMail({
    to,
    locale,
    subject: (config.confirmation.subject.trim() ? fill(config.confirmation.subject) : t(`Deine Antwort: ${title}`, `Your answer: ${title}`)).replace(/\s+/g, " "),
    title: t("Deine Antwort ist angekommen", "Your answer has arrived"),
    lines,
    heading: t("Deine Antworten", "Your answers"),
    answers,
    action: options.ticketUrl ? { label: t("Anfrage ansehen", "View request"), url: options.ticketUrl } : undefined,
  });
}

// Save and continue later: a draft per signed-in person and form. Not for
// anonymous forms, which must not tie answers to an account.
const draftInput = z.object({
  cells: z.record(z.string().max(500), z.unknown()),
  page: z.number().int().min(0).max(300).default(0),
});
function draftForm(token: string, user: Identity | null) {
  if (!user) throw new HttpError(401, "Bitte melde dich an, um einen Entwurf zu speichern.");
  const form = getForm(token, user);
  if (form.anonymous) throw new HttpError(400, "Anonyme Formulare speichern keine Entwürfe.");
  return form;
}
export function formDraft(token: string, user: Identity | null) {
  const form = draftForm(token, user);
  const draft = one<{ cells: string; page: number; updated_at: number }>(
    "SELECT cells,page,updated_at FROM form_drafts WHERE page_id=? AND user_id=?",
    form.page_id,
    user!.id,
  );
  return draft ? { cells: JSON.parse(draft.cells) as Record<string, unknown>, page: draft.page, updatedAt: draft.updated_at } : null;
}
export function saveFormDraft(token: string, user: Identity | null, input: unknown) {
  const form = draftForm(token, user);
  if (!allow(`form-draft:${user!.id}`, 60, 60_000)) throw new HttpError(429, "Zu viele Entwürfe in kurzer Zeit. Bitte später erneut versuchen.");
  const b = draftInput.parse(input);
  // Only answers to the form's questions; files are chosen again on sending.
  const asked = new Set(form.fields.filter((f) => f.type !== "files").map((f) => f.id));
  const cells = Object.fromEntries(Object.entries(b.cells).filter(([key, value]) => asked.has(key) && value !== undefined));
  const json = JSON.stringify(cells);
  if (json.length > 100_000) throw new HttpError(413, "Entwurf zu groß.");
  const now = Date.now();
  run(
    "INSERT INTO form_drafts(page_id,user_id,cells,page,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET cells=excluded.cells,page=excluded.page,updated_at=excluded.updated_at",
    form.page_id,
    user!.id,
    json,
    b.page,
    now,
  );
  // Drafts nobody came back to for half a year go away.
  run("DELETE FROM form_drafts WHERE updated_at<?", now - 180 * 24 * HOUR);
  return { updatedAt: now };
}
export function deleteFormDraft(token: string, user: Identity | null) {
  const form = draftForm(token, user);
  run("DELETE FROM form_drafts WHERE page_id=? AND user_id=?", form.page_id, user!.id);
  return { ok: true };
}
