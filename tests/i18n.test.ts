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
