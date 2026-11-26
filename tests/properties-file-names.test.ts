// Property-based tests (fast-check, tests/helpers/properties.ts) of file
// names: sanitizeFileName and uploadMime (lib/upload-safety.ts), the title of
// a page made from a file (lib/file-blocks.ts) and the names of ZIP entries
// from macOS, Windows and Info-ZIP (lib/zip-names.ts, #556). First the bugs
// they found.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { getFileNameLowLevel, validateFileName } from "yauzl";
import { check, nastyText } from "./helpers/properties";
import { sanitizeFileName, uploadMime } from "../lib/upload-safety";
import { filePageTitle } from "../lib/file-blocks";
import { decodeName, nameKey, zipEntryName } from "../lib/zip-names";

/* ---------- Regressions found by the properties ---------- */

test("regression: sanitizeFileName cuts no emoji in half and gives the same name a second time", () => {
  // 199 characters and an emoji: the cut at 200 left half of it, which the
  // download's encodeURIComponent refuses (lib/file-response.ts).
  const long = sanitizeFileName("x".repeat(199) + "😀.pdf");
  assert.equal(long, "x".repeat(199));
  encodeURIComponent(long);
  // A space at the cut, a dot behind spaces, a C1 control character.
  assert.equal(sanitizeFileName("x".repeat(199) + " y"), "x".repeat(199));
  assert.equal(sanitizeFileName(" .htaccess"), "htaccess");
  assert.equal(sanitizeFileName(" ../x"), "x");
  assert.equal(sanitizeFileName("a\u0085b\u009b.txt"), "ab.txt");
  // Half an emoji in the name itself.
  assert.equal(sanitizeFileName("a\ud83d.txt"), "a\ufffd.txt");
  for (const name of ["x".repeat(199) + " y", " .htaccess", "a\u0085b"]) assert.equal(sanitizeFileName(sanitizeFileName(name)), sanitizeFileName(name));
});
