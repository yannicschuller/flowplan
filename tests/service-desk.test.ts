import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-desk-"));
process.env.SMTP_HOST = "smtp.test.invalid";
process.env.APP_URL = "https://flowplan.test";
const { id, run, all, one, transaction } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { formSettings, getForm, saveFormSubmission } = await import("../lib/forms");
const { createTicket, customerTicket, customerReply, teamThread, teamReply } = await import("../lib/service-desk");
const { withContentLocale } = await import("../lib/content-locale");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("Olivia"),
  stranger = await user("Stranger");
const wid = await createWorkspace(owner.id, "Support"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const desk = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Support" })).id as string;
const fields: Field[] = [
  { id: "title", name: "Subject", type: "text" },
  { id: "mail", name: "E-mail", type: "email" },
  { id: "status", name: "Status", type: "select", options: ["New", "Done"] },
  { id: "owner", name: "Assignee", type: "person" },
  { id: "notes", name: "Internal notes", type: "text" },
];
await act({ action: "database.update", pageId: desk, version: (await database(desk)).version, fields, views: (await database(desk)).views });
await act({ action: "form.update", pageId: desk, enabled: true, internal: false, anonymous: true, config: { hiddenFields: ["status", "notes"], portal: true, portalFields: ["status", "owner"] } });
const { token: formToken } = (await formSettings(desk))!;
const mails = async () => await all<{ recipient: string; subject: string; text: string }>("SELECT recipient,subject,text FROM mail_queue");

// What the form route does inside its transaction.
async function submit(cells: Record<string, unknown>, locale: "de" | "en" = "en") {
  return await withContentLocale(locale, async () =>
    await transaction(async () => {
      const form = await getForm(formToken, null);
      const saved = await saveFormSubmission(desk, null, cells);
      if (!form.config.portal) return { ok: true } as { ok: true; ticket?: string; mailed?: boolean };
      const ticket = await createTicket({ pageId: desk, rowId: saved.id, title: form.title, fields: form.fields, cells });
      return { ok: true, ticket: ticket.token, mailed: ticket.mailed };
    }),
  );
}

test("a form answer gets a private link, e-mailed in the sender's language", async () => {
  const result = await submit({ title: "Printer is on fire", mail: "kim@example.com" });
  assert.ok(result.ticket, JSON.stringify(result));
  assert.equal(result.mailed, true);
  const mail = (await mails()).find((m) => m.recipient === "kim@example.com")!;
  assert.match(mail.subject, /^Your request/);
  assert.match(mail.text, new RegExp(`https://flowplan.test/ticket/${result.ticket}`));

  const ticket = await customerTicket(result.ticket);
  assert.equal(ticket.subject, "Printer is on fire");
  // Status shows; people never reach the customer.
  assert.deepEqual(ticket.status.map((s) => s.name), ["Status"]);
  assert.deepEqual(ticket.answers.map((a) => a.name), ["Subject", "E-mail"]);
  await assert.rejects(async () => await customerTicket("x".repeat(32)), /Anfrage nicht gefunden/);
});

test("customer and team talk through the record", async () => {
  const token = (await submit({ title: "Login broken", mail: "lee@example.com" }, "de")).ticket!;
  const row = (await one<{ row_id: string }>("SELECT row_id FROM tickets WHERE token=?", token))!.row_id;
  // The customer writes: the database owner hears about it.
  await transaction(async () => await customerReply(token, { body: "Still broken." }));
  const note = (await one<{ body: string; row_id: string }>("SELECT body,row_id FROM notifications WHERE user_id=? ORDER BY created_at DESC", owner.id))!;
  assert.equal(note.body, "Neue Kundenantwort zu „Login broken“");
  assert.equal(note.row_id, row);
  // The team answers from the record: e-mailed in German, as the request was.
  const thread = await act({ action: "ticket.reply", pageId: desk, rowId: row, body: "We are on it." });
  assert.deepEqual(thread.messages.map((m: { team: boolean }) => m.team), [false, true]);
  assert.ok(thread.ticket.url.endsWith(token));
  const mail = (await mails()).filter((m) => m.recipient === "lee@example.com").at(-1)!;
  assert.match(mail.subject, /^Neue Antwort zu deiner Anfrage „Login broken“/);
  assert.match(mail.text, /We are on it\./);
  const seen = await withContentLocale("de", async () => await customerTicket(token));
  assert.deepEqual(seen.messages.map((m) => [m.team, m.name]), [[false, ""], [true, "Olivia"]]);
  // Outsiders see nothing.
  await assert.rejects(async () => await teamThread(stranger, desk, row));
  await assert.rejects(async () => await teamReply(stranger, desk, row, "hi"));
  await assert.rejects(async () => await customerReply(token, { body: "   " }));
});

test("switching the portal off closes the links", async () => {
  const token = (await submit({ title: "Later" })).ticket!;
  const config = (await formSettings(desk))!.config;
  await act({ action: "form.update", pageId: desk, config: { ...config, portal: false } });
  await assert.rejects(async () => await customerTicket(token), /Anfrage nicht gefunden/);
  // Without the portal there is no link.
  const result = await submit({ title: "No portal" });
  assert.equal(result.ticket, undefined);
});
