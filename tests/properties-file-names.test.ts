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
test("regression: a page made from a long file name is cut without halving an emoji", () => {
  assert.equal(filePageTitle("x".repeat(299) + "😀😀.pdf"), "x".repeat(299));
  assert.equal(filePageTitle("x".repeat(299) + " y.pdf"), "x".repeat(299));
});

/* ---------- Properties ---------- */

// Names as people, browsers, archives and scripts send them: path parts,
// dots, control characters, unicode (also decomposed), and long ones.
const namePiece = fc.oneof(
  { weight: 3, arbitrary: nastyText(3) },
  { weight: 2, arbitrary: fc.constantFrom("/", "\\", "..", ".", " ", "../", "..\\", "C:", ".htaccess", ".pdf", ".tar.gz", "\u0000", "\n", "\u0085", "\u009b", "\u202e") },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 4 }) },
);
const fileName = fc.oneof(
  { weight: 4, arbitrary: fc.array(namePiece, { maxLength: 8 }).map((parts) => parts.join("")) },
  // Long names, cut at the limit in the middle of an emoji or after a space.
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.integer({ min: 190, max: 320 }), fc.constantFrom("😀", " ", "e\u0301", "中", "a"), fc.constantFrom("", ".pdf", " .txt"))
      .map(([length, unit, extension]) => "x".repeat(length - 1) + unit.repeat(3) + extension),
  },
);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

test("property: sanitizeFileName gives one safe, well-formed name, and is idempotent", () => {
  check(
    fc.property(fileName, (name) => {
      const clean = sanitizeFileName(name);
      assert.ok(clean.length > 0 && clean.length <= 200, JSON.stringify(clean));
      assert.doesNotMatch(clean, /[/\\]/);
      assert.doesNotMatch(clean, CONTROL, JSON.stringify(clean));
      // Neither hidden (".htaccess") nor "." / "..".
      assert.doesNotMatch(clean, /^\./, JSON.stringify(clean));
      assert.equal(clean, clean.trim(), JSON.stringify(clean));
      assert.ok(clean.isWellFormed(), JSON.stringify(clean));
      assert.equal(clean, clean.normalize("NFC"));
      // The download names it (lib/file-response.ts).
      encodeURIComponent(clean);
      assert.equal(sanitizeFileName(clean), clean, JSON.stringify(clean));
    }),
    500,
  );
});

test("property: uploadMime never keeps a type a browser could run", () => {
  check(
    fc.property(
      fc.oneof(fc.constantFrom("text/html", "image/svg+xml", "TEXT/HTML; charset=utf-8", "application/xhtml+xml", "text/javascript", "image/png", "application/pdf", ""), nastyText(3)),
      fileName,
      fc.uint8Array({ maxLength: 64 }).map((bytes) => Buffer.from(bytes)),
      (claimed, name, data) => {
        const mime = uploadMime(claimed, name, data);
        assert.ok(mime.length > 0);
        assert.doesNotMatch(mime, /html|svg|xml|javascript|ecmascript/);
      },
    ),
    500,
  );
});

test("property: a page made from a file is named without the extension, never empty or cut in a character", () => {
  check(
    fc.property(fileName, (name) => {
      const title = filePageTitle(name);
      assert.ok(title.length <= 300);
      assert.ok(title.isWellFormed(), JSON.stringify(title));
      assert.equal(title, title.trim(), JSON.stringify(title));
      if (name.trim()) assert.ok(title.length > 0, JSON.stringify(name));
      const match = /^(.*\S)\s*\.[a-z0-9]{1,8}$/i.exec(name.trim());
      if (match && match[1].length <= 300) assert.equal(title, match[1].trim());
    }),
    500,
  );
});

// A ZIP entry as yauzl gives it (strictFileNames, lib/archive.ts): the raw
// name, the general-purpose flags and the name decoded by them.
function entry(raw: Buffer, utf8Flag: boolean) {
  const flags = utf8Flag ? 0x800 : 0;
  return { fileNameRaw: raw, generalPurposeBitFlag: flags, fileName: getFileNameLowLevel(flags, raw, [], true) };
}
// Names yauzl's own check lets through (no absolute paths, "..", backslashes).
const zipName = fc
  .array(fc.oneof(nastyText(3), fc.constantFrom("Diárias", "Notizen/", "ä", "a\u0308", "日本語", "😀", "/")), { minLength: 1, maxLength: 6 })
  .map((parts) => parts.join("").replace(/\u0000/g, ""))
  .filter((name) => !validateFileName(name) && name.isWellFormed());

test("property: ZIP names from macOS (raw UTF-8, decomposed) and with bit 11 come out as the same NFC name", () => {
  check(
    fc.property(zipName, fc.boolean(), fc.constantFrom<"NFC" | "NFD">("NFC", "NFD"), (name, utf8Flag, form) => {
      const raw = Buffer.from(name.normalize(form), "utf8");
      const read = zipEntryName(entry(raw, utf8Flag));
      assert.equal(read, name.normalize("NFC"));
      assert.equal(validateFileName(read), null);
      // Links typed in either form find it.
      assert.equal(nameKey(name.normalize("NFD")), nameKey(read));
      assert.equal(decodeName(encodeURIComponent(name.normalize("NFD"))), read);
    }),
    500,
  );
});

test("property: ZIP names that are no UTF-8 are read as CP437 and never throw for safe names", () => {
  check(
    fc.property(fc.uint8Array({ minLength: 1, maxLength: 24 }), (bytes) => {
      const raw = Buffer.from(bytes);
      const cp437 = getFileNameLowLevel(0, raw, [], true);
      if (validateFileName(cp437)) return;
      let utf8: string | null = null;
      try {
        utf8 = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        // Not UTF-8.
      }
      // A UTF-8 reading of a safe CP437 name can still hold "..": refused.
      let read: string;
      try {
        read = zipEntryName(entry(raw, false));
      } catch (error) {
        assert.ok(utf8 !== null && validateFileName(utf8.normalize("NFC")), String(error));
        return;
      }
      assert.equal(read, (utf8 ?? cp437).normalize("NFC"));
    }),
    500,
  );
});
