import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLocale, translate } from "../lib/i18n";

test("the language: the reader's choice first, then the browser, English otherwise", () => {
  assert.equal(pickLocale("en", "de-DE,de;q=0.9"), "en");
  assert.equal(pickLocale("de", "en-US"), "de");
  assert.equal(pickLocale(null, "de-AT,de;q=0.9,en;q=0.8"), "de");
  assert.equal(pickLocale(undefined, "en-GB,en;q=0.9,de;q=0.8"), "en");
  assert.equal(pickLocale(undefined, "fr-FR,fr;q=0.9,de;q=0.8"), "fr");
  assert.equal(pickLocale(undefined, "it-IT,es;q=0.9"), "en");
  assert.equal(pickLocale("fr", "de-DE"), "fr");
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

test("further languages come from catalogues keyed by the English text", async () => {
  const t = translate("fr");
  assert.equal(t("Anmelden", "Sign in"), "Se connecter");
  // Texts with variables are matched as patterns, the values kept.
  assert.equal(t("Gruppe Rot", "Group Rot"), "Groupe Rot");
  assert.equal(t("x", "Ada mentioned you in “Plan”"), "Ada vous a mentionné dans « Plan »");
  // Not in the catalogue: English.
  assert.equal(t("Gibt es nicht", "Does not exist"), "Does not exist");
  // German server messages reach French readers through their English version.
  const { localizedMessage } = await import("../lib/i18n-errors");
  assert.equal(localizedMessage("Seite nicht gefunden.", "fr"), "Page introuvable.");
  assert.equal(localizedMessage("Eigenschaft „Status“ wurde nicht gefunden.", "fr"), "La propriété « Status » est introuvable.");
});

test("catalogues keep the placeholders of their texts (missing translations are only reported)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const english = Object.keys(JSON.parse(readFileSync("locales/en.json", "utf8")));
  const marks = (text: string) => (text.match(/\{\d+\}/g) || []).sort().join();
  for (const file of readdirSync("locales").filter((f) => f !== "en.json" && f.endsWith(".json"))) {
    const catalog = JSON.parse(readFileSync(`locales/${file}`, "utf8")) as Record<string, string>;
    const broken = Object.entries(catalog).filter(([key, value]) => value && marks(key) !== marks(value));
    assert.deepEqual(broken, [], `${file}: placeholders differ`);
    const missing = english.filter((key) => !catalog[key]);
    if (missing.length) console.log(`${file}: ${missing.length} of ${english.length} texts not translated yet (shown in English) – npm run i18n -- --check --missing`);
  }
});

test("short patterns do not rewrite whole sentences", () => {
  const t = translate("fr");
  assert.equal(t("3 von 5", "3 of 5"), "3 sur 5");
  assert.equal(t("x", "Name and appearance of the space, your profile"), "Name and appearance of the space, your profile");
});
