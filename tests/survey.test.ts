import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-survey-"));
const { id, run, one, all: rowsOf } = await import("../lib/db");
const { command, database, bootstrap, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { newQuestion, surveySchema, validateSurvey, conditionMet, surveyPages, surveyClosed } = await import("../lib/survey");
const { formSettings, getForm, saveFormSubmission } = await import("../lib/forms");
const { surveyResults } = await import("../lib/survey-results");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Surveys"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Feedback" })).id as string;

// A survey as the builder sends it.
const q = (type: Parameters<typeof newQuestion>[0]) => newQuestion(type, "de");
const nps = q("nps"),
  choice = q("single"),
  reason = q("long"),
  matrix = q("matrix"),
  rank = q("ranking"),
  stars = q("rating"),
  time = q("time");
reason.question.showIf = { field: nps.question.field, op: "lte", value: "6" };
choice.question.other = true;
nps.question.required = true;
const items = [
  nps.question,
  reason.question,
  { kind: "page" as const, id: "p2", title: "Mehr" },
  choice.question,
  matrix.question,
  rank.question,
  stars.question,
  time.question,
];
const all = [nps, reason, choice, matrix, rank, stars, time];

test("saving creates properties and form settings in one step", async () => {
  const result = await act({
    action: "survey.save",
    pageId,
    version: (await database(pageId)).version,
    survey: { enabled: true, items, onePerPerson: true },
    questions: Object.fromEntries(all.map((x) => [x.question.id, { title: x.title, options: x.options }])),
    form: { submitLabel: "Senden", successTitle: "Danke!" },
  });
  const fields = (await database(pageId)).fields;
  // Matrix: one property per row.
  assert.equal(fields.filter((f) => f.name.startsWith(matrix.title)).length, 2);
  assert.equal(fields.find((f) => f.id === result.fields[nps.question.field])!.type, "number");
  const config = (await formSettings(pageId))!.config;
  assert.equal(config.survey!.items.length, 8);
  // The condition now points at the stored property.
  assert.equal(config.survey!.items[1].kind === "question" && config.survey!.items[1].showIf!.field, result.fields[nps.question.field]);
  assert.ok(config.requiredFields.includes(result.fields[nps.question.field]));
  assert.equal(surveyPages(config.survey!).length, 2);
});

test("answers are checked by type and conditions", async () => {
  const config = (await formSettings(pageId))!.config;
  const survey = config.survey!;
  const fields = (await database(pageId)).fields;
  const id = (draft: string) => (survey.items.find((i) => i.kind === "question" && i.id === draft) as { field: string }).field;
  const f = { nps: id(nps.question.id), reason: id(reason.question.id), choice: id(choice.question.id), rank: id(rank.question.id), stars: id(stars.question.id), time: id(time.question.id) };
  const mq = survey.items.find((i) => i.kind === "question" && i.type === "matrix") as { rows: { field: string }[]; columns: string[] };
  // Required NPS missing; out of range; ranking incomplete; bad time.
  let r = validateSurvey(survey, fields, { [f.rank]: ["A"], [f.time]: "25:00", [f.stars]: 9 });
  assert.deepEqual(Object.keys(r.errors).sort(), [f.nps, f.rank, f.stars, f.time].sort());
  // "Other" text is accepted for a choice with "Other".
  r = validateSurvey(survey, fields, { [f.nps]: 9, [f.choice]: "Etwas anderes", [mq.rows[0].field]: mq.columns[1], [f.rank]: ["C", "A", "B"], [f.stars]: 4, [f.time]: "09:30", [f.reason]: "hidden" });
  assert.deepEqual(r.errors, {});
  // The reason question is only shown for detractors: its answer is dropped.
  assert.equal(r.cells[f.reason], undefined);
  assert.equal(r.cells[f.choice], "Etwas anderes");
  assert.deepEqual(r.cells[f.rank], ["C", "A", "B"]);
  assert.equal(conditionMet({ field: f.nps, op: "lte", value: "6" }, { [f.nps]: 3 }), true);
  assert.equal(surveyClosed(surveySchema.parse({ closesAt: "2000-01-01T00:00:00Z" }), 0), "closed");
  assert.equal(surveyClosed(surveySchema.parse({ limit: 2 }), 2), "full");
});

test("submissions become records; results summarise them", async () => {
  const survey = (await formSettings(pageId))!.config.survey!;
  const field = (draft: string) => (survey.items.find((i) => i.kind === "question" && i.id === draft) as { field: string }).field;
  const send = async (score: number, extra: Record<string, unknown> = {}) => await saveFormSubmission(pageId, owner, { [field(nps.question.id)]: score, ...extra }, true);
  await send(10);
  await send(9);
  await send(3, { [field(reason.question.id)]: "Zu teuer" });
  await send(7);
  await assert.rejects(async () => await send(11), /zwischen 0 und 10/);
  const result = surveyResults(survey, (await database(pageId)).fields, await rows(pageId));
  assert.equal(result.responses, 4);
  const npsResult = result.questions.find((x) => x.q.id === nps.question.id)!;
  assert.equal(npsResult.kind === "number" && npsResult.nps!.score, 25);
  const text = result.questions.find((x) => x.q.id === reason.question.id)!;
  assert.deepEqual(text.kind === "text" && text.answers, ["Zu teuer"]);
  void getForm;
  void one;
});

test("a hidden page break hides its page; tampered answers do not unlock it", () => {
  const gate = q("yesno"),
    detail = q("short"),
    follow = q("short");
  const survey = surveySchema.parse({
    enabled: true,
    items: [
      { ...gate.question, field: "gate" },
      { kind: "page", id: "pg", title: "Details", showIf: { field: "gate", op: "is", value: "Ja" } },
      { ...detail.question, field: "detail", required: true },
      { ...follow.question, field: "follow", required: true, showIf: { field: "detail", op: "contains", value: "x" } },
    ],
  });
  const fields = [
    { id: "gate", name: "Gate", type: "select" as const, options: ["Ja", "Nein"] },
    { id: "detail", name: "Detail", type: "text" as const },
    { id: "follow", name: "Follow", type: "text" as const },
  ];
  // "Nein": the second page and everything on it is skipped and dropped.
  let r = validateSurvey(survey, fields, { gate: "Nein", detail: "x", follow: "y" });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.cells, { gate: "Nein" });
  assert.equal(surveyPages(survey, { gate: "Nein" }).length, 1);
  r = validateSurvey(survey, fields, { gate: "Ja", detail: "xy" });
  assert.deepEqual(Object.keys(r.errors), ["follow"]);
  assert.equal(surveyPages(survey, { gate: "Ja" }).length, 2);
});

test("form follow-ups: confirmation e-mail, team notification, hidden answers dropped, drafts", async () => {
  process.env.SMTP_HOST = "smtp.test.invalid";
  const { formDraft, saveFormDraft, confirmFormAnswer } = await import("../lib/forms");
  try {
    const member = await user("member"),
      stranger = await user("stranger");
    await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
    const page = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Anfragen" })).id as string;
    const fields = [
      { id: "title", name: "Name", type: "text" },
      { id: "mail", name: "E-Mail", type: "email" },
      { id: "kind", name: "Art", type: "select", options: ["Fehler", "Lob"] },
      { id: "steps", name: "Schritte", type: "text" },
      { id: "notes", name: "Interne Notiz", type: "text" },
    ];
    await act({ action: "database.update", pageId: page, version: (await database(page)).version, fields, views: (await database(page)).views });
    await act({
      action: "form.update",
      pageId: page,
      enabled: true,
      internal: false,
      anonymous: true,
      config: {
        hiddenFields: ["notes"],
        requiredFields: ["steps"],
        logic: { steps: { field: "kind", op: "is", value: "Fehler" } },
        confirmation: { enabled: true, subject: "Danke, {Name}", message: "Hallo {Name},\n\nwir melden uns." },
        notifyMembers: [member.id, stranger.id],
      },
    });
    const mails = async () => await rowsOf<{ recipient: string; subject: string; text: string }>("SELECT recipient,subject,text FROM mail_queue ORDER BY seq");
    const before = (await mails()).length;
    // "Lob": the required "Schritte" is hidden, so not required, and its
    // answer is dropped; internal fields never reach the record or the mail.
    const saved = await saveFormSubmission(page, null, { title: "Kim", mail: "kim@example.com", kind: "Lob", steps: "secret", notes: "x" });
    const cells = JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", saved.id))!.cells);
    assert.equal(cells.steps, undefined);
    assert.equal(cells.notes, undefined);
    assert.equal(saved.confirmed, true);
    const mail = (await mails()).slice(before).find((m) => m.recipient === "kim@example.com")!;
    assert.equal(mail.subject, "Danke, Kim");
    assert.match(mail.text, /^Hallo Kim,\n\nwir melden uns\./);
    assert.match(mail.text, /- Art: Lob/);
    assert.doesNotMatch(mail.text, /secret|Interne Notiz|Schritte/);
    // Only the member hears about it; a stranger is not in the workspace.
    const notes = await rowsOf<{ user_id: string; body: string }>("SELECT user_id,body FROM notifications WHERE row_id=?", saved.id);
    assert.deepEqual(notes.map((n) => [n.user_id, n.body]), [[member.id, "Neue Antwort über „Anfragen“"]]);
    // Anonymous: no typed address, no mail – even for a signed-in person.
    const count = (await mails()).length;
    await saveFormSubmission(page, owner, { title: "Ohne", kind: "Lob" });
    assert.equal((await mails()).length, count);
    // With the customer portal the link goes into the confirmation.
    assert.equal(await confirmFormAnswer(page, null, { title: "Lee", mail: "lee@example.com" }, { ticketUrl: "https://flowplan.test/ticket/abc" }), true);
    assert.match((await mails()).at(-1)!.text, /https:\/\/flowplan\.test\/ticket\/abc/);
    // Per recipient: at most five an hour.
    for (let i = 0; i < 6; i++) await confirmFormAnswer(page, null, { mail: "flood@example.com" });
    assert.equal((await mails()).filter((m) => m.recipient === "flood@example.com").length, 5);

    // Not anonymous: the account's address; drafts for signed-in people.
    await act({ action: "form.update", pageId: page, anonymous: false });
    const { token } = (await formSettings(page))!;
    await saveFormSubmission(page, owner, { title: "Olli", kind: "Lob" });
    assert.equal((await mails()).at(-1)!.recipient, owner.email);
    await saveFormDraft(token, owner, { cells: { title: "Halb", steps: "1", unknown: "x" }, page: 1 });
    const draft = (await formDraft(token, owner))!;
    assert.deepEqual({ cells: draft.cells, page: draft.page }, { cells: { title: "Halb", steps: "1" }, page: 1 });
    await assert.rejects(async () => await saveFormDraft(token, null, { cells: {} }), /melde dich an/);
    // Sending replaces the draft.
    await saveFormSubmission(page, owner, { title: "Fertig", kind: "Lob" });
    assert.equal(await formDraft(token, owner), null);
    await act({ action: "form.update", pageId: page, anonymous: true });
    await assert.rejects(async () => await formDraft(token, owner), /Anonyme Formulare/);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test("survey.save keeps follow-up settings it was not sent", async () => {
  const config = (await formSettings(pageId))!.config;
  await act({ action: "form.update", pageId, config: { ...config, notifyMembers: [owner.id], redirectUrl: "https://example.com/{x}" } });
  const fields = (await database(pageId)).fields;
  await act({
    action: "survey.save",
    pageId,
    version: (await database(pageId)).version,
    survey: config.survey,
    questions: Object.fromEntries(
      config.survey!.items.flatMap((i) => (i.kind === "question" ? [[i.id, { title: i.title || "Frage", options: fields.find((f) => f.id === i.field)?.options }]] : [])),
    ),
    form: { submitLabel: "Senden" },
  });
  assert.deepEqual((await formSettings(pageId))!.config.notifyMembers, [owner.id]);
  assert.equal((await formSettings(pageId))!.config.redirectUrl, "https://example.com/{x}");
});

test("a ranking option added after answers comes last, without an average", () => {
  const ranking = q("ranking");
  const survey = surveySchema.parse({ enabled: true, items: [{ ...ranking.question, field: "r" }] });
  const fields = [{ id: "r", name: "Rang", type: "multiselect" as const, options: ["A", "B", "Neu", "C"] }];
  const answers = [["A", "B", "C"], ["B", "A", "C"]].map((r) => ({ cells: { r } })) as unknown as Parameters<typeof surveyResults>[2];
  const result = surveyResults(survey, fields, answers).questions[0];
  assert.deepEqual(result.kind === "ranking" && result.items, [
    { label: "A", average: 1.5 },
    { label: "B", average: 1.5 },
    { label: "C", average: 3 },
    { label: "Neu", average: null },
  ]);
});
