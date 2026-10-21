import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answersByName,
  conditionMet,
  evaluateLogic,
  fillPlaceholders,
  logicPages,
  redirectTarget,
  validRedirect,
  type LogicItem,
} from "../lib/form-logic";
import { formConfigSchema, formItems, formLogic, formRedirect, validateFormValues } from "../lib/form-settings";
import type { Field } from "../lib/types";

test("conditions compare answers", () => {
  const v = { choice: "Ja", multi: ["A", "B"], n: 7, text: "Der Drucker brennt", empty: "", flag: true, off: false };
  assert.equal(conditionMet({ field: "choice", op: "is", value: "Ja" }, v), true);
  assert.equal(conditionMet({ field: "choice", op: "isNot", value: "Ja" }, v), false);
  assert.equal(conditionMet({ field: "multi", op: "includes", value: "B" }, v), true);
  assert.equal(conditionMet({ field: "multi", op: "notIncludes", value: "C" }, v), true);
  assert.equal(conditionMet({ field: "text", op: "contains", value: "drucker" }, v), true);
  assert.equal(conditionMet({ field: "text", op: "contains", value: "" }, v), false);
  assert.equal(conditionMet({ field: "n", op: "gt", value: "6" }, v), true);
  assert.equal(conditionMet({ field: "n", op: "gt", value: "7" }, v), false);
  assert.equal(conditionMet({ field: "n", op: "lt", value: "7,5" }, v), true);
  assert.equal(conditionMet({ field: "n", op: "gte", value: "7" }, v), true);
  assert.equal(conditionMet({ field: "n", op: "lte", value: "6" }, v), false);
  // No number to compare with: never true.
  assert.equal(conditionMet({ field: "n", op: "gt", value: "" }, v), false);
  assert.equal(conditionMet({ field: "text", op: "gt", value: "1" }, v), false);
  assert.equal(conditionMet({ field: "empty", op: "answered", value: "" }, v), false);
  assert.equal(conditionMet({ field: "missing", op: "notAnswered", value: "" }, v), true);
  assert.equal(conditionMet({ field: "flag", op: "answered", value: "" }, v), true);
  assert.equal(conditionMet({ field: "off", op: "answered", value: "" }, v), false);
  assert.equal(conditionMet(undefined, v), true);
});

test("hidden questions hide what depends on them; hidden page breaks hide their page", () => {
  const items: LogicItem[] = [
    { id: "q1", kind: "question", fields: ["kind"] },
    { id: "q2", kind: "question", fields: ["detail"], showIf: { field: "kind", op: "is", value: "Fehler" } },
    // Depends on a question that may be hidden.
    { id: "q3", kind: "question", fields: ["severity"], showIf: { field: "detail", op: "answered", value: "" } },
    { id: "t1", kind: "text", showIf: { field: "kind", op: "is", value: "Lob" } },
    { id: "p2", kind: "page", showIf: { field: "kind", op: "is", value: "Fehler" } },
    { id: "q4", kind: "question", fields: ["steps"] },
    { id: "p3", kind: "page" },
    { id: "q5", kind: "question", fields: ["mail"] },
  ];
  // "detail" was typed but its question is hidden: q3 stays hidden too.
  let r = evaluateLogic(items, { kind: "Lob", detail: "sneaky", steps: "x", mail: "a@b.c" });
  assert.deepEqual([...r.shown].sort(), ["p3", "q1", "q5", "t1"]);
  assert.deepEqual([...r.hiddenFields].sort(), ["detail", "severity", "steps"]);
  assert.deepEqual(r.answers, { kind: "Lob", mail: "a@b.c" });
  assert.deepEqual(
    logicPages(items, r).map((p) => p.shown.map((i) => i.id)),
    [["q1", "t1"], ["q5"]],
  );
  r = evaluateLogic(items, { kind: "Fehler", detail: "Absturz" });
  assert.ok(r.shown.has("q3") && r.shown.has("q4") && !r.shown.has("t1"));
  assert.equal(logicPages(items, r).length, 3);
});

test("placeholders and redirects", () => {
  const fields = [
    { id: "a", name: "Name", type: "text" },
    { id: "b", name: "Themen", type: "multiselect" },
    { id: "c", name: "Zuständig", type: "person" },
  ];
  const answer = answersByName(fields, { a: "Kim & Co", b: ["A", "B"], c: "user-id" });
  assert.equal(fillPlaceholders("Danke, {name}! Themen: {Themen}. {Unbekannt} {Zuständig}", answer), "Danke, Kim & Co! Themen: A, B. {Unbekannt} {Zuständig}");
  assert.equal(validRedirect(""), true);
  assert.equal(validRedirect("http://example.com"), false);
  assert.equal(validRedirect("javascript:alert(1)"), false);
  // The host must not come from an answer.
  assert.equal(validRedirect("https://{Name}.example.com/"), false);
  assert.equal(validRedirect("https://example.com/danke?name={Name}"), true);
  assert.equal(redirectTarget("https://example.com/danke?name={Name}", answer), "https://example.com/danke?name=Kim%20%26%20Co");
  assert.equal(redirectTarget("http://example.com/", answer), null);
  // Older surveys kept an http address: not followed.
  const config = formConfigSchema.parse({ survey: { enabled: true, redirect: "http://example.com" } });
  assert.equal(formRedirect(config), undefined);
  assert.deepEqual(formRedirect(formConfigSchema.parse({ redirectUrl: "https://example.com", redirectDelay: 0 })), { url: "https://example.com", delay: 0 });
  assert.throws(() => formConfigSchema.parse({ redirectUrl: "http://example.com" }));
});

test("ordinary forms: blocks, conditions and validation share one evaluator", () => {
  const fields: Field[] = [
    { id: "title", name: "Betreff", type: "text" },
    { id: "kind", name: "Art", type: "select", options: ["Fehler", "Wunsch"] },
    { id: "steps", name: "Schritte", type: "text" },
    { id: "score", name: "Wichtigkeit", type: "number" },
    { id: "why", name: "Warum", type: "text" },
  ];
  const config = formConfigSchema.parse({
    requiredFields: ["steps", "why"],
    logic: {
      steps: { field: "kind", op: "is", value: "Fehler" },
      why: { field: "score", op: "gte", value: "8" },
      // Points at a later question: ignored.
      title: { field: "why", op: "answered", value: "" },
    },
    blocks: [
      { id: "b1", kind: "page", before: "score", showIf: { field: "kind", op: "is", value: "Wunsch" } },
      { id: "b2", kind: "text", before: "", title: "Danke" },
    ],
  });
  assert.deepEqual(
    formItems(fields, config).map((i) => i.id),
    ["title", "kind", "steps", "b1", "score", "why", "b2"],
  );
  assert.equal(formItems(fields, config)[0].showIf, undefined);
  // A bug report: the second page (score, why) is hidden, steps required.
  let r = validateFormValues(fields, config, { title: "x", kind: "Fehler", score: 9, why: "weil" });
  assert.deepEqual(Object.keys(r.errors), ["steps"]);
  r = validateFormValues(fields, config, { title: "x", kind: "Fehler", steps: "1, 2", score: 9, why: "weil" });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.cells, { title: "x", kind: "Fehler", steps: "1, 2" });
  // A wish: steps hidden and dropped; "why" required from 8 on.
  r = validateFormValues(fields, config, { title: "x", kind: "Wunsch", steps: "ignored", score: 9 });
  assert.deepEqual(Object.keys(r.errors), ["why"]);
  r = validateFormValues(fields, config, { title: "x", kind: "Wunsch", steps: "ignored", score: 3, why: "dropped" });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.cells, { title: "x", kind: "Wunsch", score: 3 });
  assert.ok(formLogic(fields, config, { kind: "Wunsch" }).shown.has("b1"));
});
