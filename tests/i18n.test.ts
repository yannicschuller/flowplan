import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLocale, translate } from "../lib/i18n";

test("the language: the reader's choice first, then the browser, English otherwise", () => {
  assert.equal(pickLocale("en", "de-DE,de;q=0.9"), "en");
  assert.equal(pickLocale("de", "en-US"), "de");
  assert.equal(pickLocale(null, "de-AT,de;q=0.9,en;q=0.8"), "de");
  assert.equal(pickLocale(undefined, "en-GB,en;q=0.9,de;q=0.8"), "en");
  assert.equal(pickLocale(undefined, "fr-FR,fr;q=0.9,de;q=0.8"), "de");
  assert.equal(pickLocale(undefined, "fr-FR,es;q=0.9"), "en");
  assert.equal(pickLocale(undefined, "en;q=0.5,de;q=0.9"), "de");
  assert.equal(pickLocale("xx", null), "en");
  assert.equal(translate("en")("Anmelden", "Sign in"), "Sign in");
});

test("server messages have an English version, with values kept", async () => {
  const { englishMessage } = await import("../lib/i18n-errors");
  assert.equal(englishMessage("Seite nicht gefunden."), "Page not found.");
  assert.equal(
    englishMessage("Speicherkontingent des Arbeitsbereichs erschöpft (12,5 MB von 10 MB belegt)."),
    "The workspace's storage quota is used up (12,5 MB of 10 MB used).",
  );
  assert.equal(englishMessage("Eigenschaft „Status“ wurde nicht gefunden."), "Property “Status” was not found.");
  assert.equal(englishMessage("Something else"), "Something else");
});

test("every German HttpError message has an English version", async () => {
  const { englishMessage } = await import("../lib/i18n-errors");
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  const missing = [];
  for (const file of [...files("lib"), ...files("app")])
    for (const [, text] of readFileSync(file, "utf8").matchAll(/new HttpError\(\s*\d+,\s*"([^"]+)"/g))
      if (/[äöüß]|\b(nicht|kein|Keine?|Bitte|Ungültig\w*|fehlt)\b/.test(text) && englishMessage(text) === text)
        missing.push(`${file}: ${text}`);
  assert.deepEqual(missing, []);
});

test("notifications are shown in the reader's language", async () => {
  const { englishMessage } = await import("../lib/i18n-errors");
  assert.equal(englishMessage("Ada hat dich in einem Kommentar in „Plan“ erwähnt"), "Ada mentioned you in a comment in “Plan”");
  assert.equal(englishMessage("Ada hat dich in „Plan“ erwähnt"), "Ada mentioned you in “Plan”");
  assert.equal(englishMessage("Ada kommentiert „Plan“"), "Ada commented on “Plan”");
  assert.equal(englishMessage("Heute fällig: Bericht (Plan) („Woche“)"), "Due today: Bericht (Plan) (“Woche”)");
});
