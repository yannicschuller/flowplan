import { test } from "node:test";
import assert from "node:assert/strict";
import { helpCandidates, stem } from "../lib/ai/help";

const top = (locale: "de" | "en", question: string, n = 3) =>
  helpCandidates(locale, question.split(" ")).slice(0, n).map((s) => `${s.slug}#${s.heading}`);

test("help: short verb forms meet the help's infinitives", () => {
  assert.equal(stem("teile"), stem("teilen"));
  assert.equal(stem("seite"), stem("seiten"));
  assert.equal(stem("lege"), "lege");
});

test("help: 'how do I create …' finds the page about it and how to start", () => {
  assert.match(top("de", "wie erstelle ich einen workflow")[0], /^workflows#/);
  assert.ok(top("de", "wie erstelle ich einen workflow").some((s) => /^workflows#(Erste Schritte|Wie ein Workflow beginnt)/.test(s)));
  assert.match(top("en", "how do I create a workflow")[0], /^workflows#First steps/);
  assert.equal(top("de", "wie lege ich eine datenbank an")[0], "databases#Datenbank anlegen");
});

test("help: sharing questions reach the sharing page", () => {
  assert.match(top("de", "wie teile ich eine seite")[0], /^sharing#/);
  assert.match(top("en", "how do I share a page")[0], /^sharing#/);
});

test("help: topic questions keep their sections", () => {
  assert.equal(top("de", "2fa einrichten")[0], "sign-in#Zwei-Faktor-Anmeldung");
  assert.equal(top("de", "journal pin")[0], "journal#PIN-Sperre");
  assert.equal(top("de", "kalender synchronisieren google")[0], "views#Mit Google Kalender oder Outlook synchronisieren");
});
