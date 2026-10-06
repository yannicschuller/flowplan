import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-survey-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { newQuestion, surveySchema, validateSurvey, conditionMet, surveyPages, surveyClosed } = await import("../lib/survey");
const { formSettings, getForm, saveFormSubmission } = await import("../lib/forms");
const { surveyResults } = await import("../lib/survey-results");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner");
const wid = createWorkspace(owner.id, "Surveys"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Feedback" }).id as string;

// A survey as the builder sends it.
const q = (type: Parameters<typeof newQuestion>[0]) => newQuestion(type, true);
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

test("saving creates properties and form settings in one step", () => {
  const result = act({
    action: "survey.save",
    pageId,
    version: database(pageId).version,
    survey: { enabled: true, items, onePerPerson: true },
    questions: Object.fromEntries(all.map((x) => [x.question.id, { title: x.title, options: x.options }])),
    form: { submitLabel: "Senden", successTitle: "Danke!" },
  });
  const fields = database(pageId).fields;
  // Matrix: one property per row.
  assert.equal(fields.filter((f) => f.name.startsWith(matrix.title)).length, 2);
  assert.equal(fields.find((f) => f.id === result.fields[nps.question.field])!.type, "number");
  const config = formSettings(pageId)!.config;
  assert.equal(config.survey!.items.length, 8);
  // The condition now points at the stored property.
  assert.equal(config.survey!.items[1].kind === "question" && config.survey!.items[1].showIf!.field, result.fields[nps.question.field]);
  assert.ok(config.requiredFields.includes(result.fields[nps.question.field]));
  assert.equal(surveyPages(config.survey!).length, 2);
});

test("answers are checked by type and conditions", () => {
  const config = formSettings(pageId)!.config;
  const survey = config.survey!;
  const fields = database(pageId).fields;
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

test("submissions become records; results summarise them", () => {
  const survey = formSettings(pageId)!.config.survey!;
  const field = (draft: string) => (survey.items.find((i) => i.kind === "question" && i.id === draft) as { field: string }).field;
  const send = (score: number, extra: Record<string, unknown> = {}) => saveFormSubmission(pageId, owner, { [field(nps.question.id)]: score, ...extra }, true);
  send(10);
  send(9);
  send(3, { [field(reason.question.id)]: "Zu teuer" });
  send(7);
  assert.throws(() => send(11), /zwischen 0 und 10/);
  const result = surveyResults(survey, database(pageId).fields, rows(pageId));
  assert.equal(result.responses, 4);
  const npsResult = result.questions.find((x) => x.q.id === nps.question.id)!;
  assert.equal(npsResult.kind === "number" && npsResult.nps!.score, 25);
  const text = result.questions.find((x) => x.q.id === reason.question.id)!;
  assert.deepEqual(text.kind === "text" && text.answers, ["Zu teuer"]);
  void getForm;
  void one;
});
