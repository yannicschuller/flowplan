// Microsoft Word (#122): a single .docx or a ZIP of them – every document
// becomes a page titled by its file name, folders become parent pages. The
// conversion is lib/importers/docx.ts, the tree the one of the Google Docs
// import (documentPages, resolveDocx).
// Formats Flowplan cannot read are recognised by extension and first bytes
// and refused with what to do instead: older Word files (.doc, an OLE2
// compound file) and OneNote (.one/.onetoc2 with their own file GUID,
// .onepkg a CAB archive). In a ZIP they are skipped and named in the
// preview's warnings.
import { posix } from "node:path";
import { HttpError } from "../auth";
import { documentPages } from "./google-docs";
import { warningList, type ImportFile, type ImportTree } from "./types";

export type LegacyOffice = "doc" | "onenote";

export const DOC_REFUSAL = "Ältere Word-Dateien (.doc) kann Flowplan nicht lesen. Öffne die Datei in Word, LibreOffice oder Pages und speichere sie als .docx.";
export const ONENOTE_REFUSAL =
  "OneNote-Dateien (.one, .onetoc2, .onepkg) kann Flowplan nicht lesen. Exportiere in OneNote die Seite oder den Abschnitt als Word-Dokument (.docx) – unter Windows über Datei → Exportieren – und importiere es über „Microsoft Word“. Bietet deine OneNote-Version nur PDF an, lade das PDF als Datei hoch.";
export const legacyRefusal = (kind: LegacyOffice) => (kind === "doc" ? DOC_REFUSAL : ONENOTE_REFUSAL);
// A skipped file inside a ZIP.
export const legacySkipped = (name: string, kind: LegacyOffice) =>
  kind === "doc"
    ? `${name}: ältere Word-Datei (.doc) übersprungen – bitte in Word, LibreOffice oder Pages als .docx speichern.`
    : `${name}: OneNote-Datei übersprungen – bitte in OneNote als Word-Dokument (.docx) exportieren.`;

const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const CAB = Buffer.from("MSCF", "latin1");
// guidFileType of a OneNote section (.one) and table of contents (.onetoc2)
// as stored on disk (MS-ONESTORE 2.3.1): {7B5C52E4-D88C-4DA7-AEB1-5378D02996D3}
// and {43FF2FA1-EFD9-4C76-9EE2-10EA5722765F}.
const ONE = Buffer.from("e4525c7b8cd8a74daeb15378d02996d3", "hex");
const ONETOC2 = Buffer.from("a12fff43d9ef764c9ee210ea5722765f", "hex");
const starts = (bytes: Buffer, magic: Buffer) => bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);

// Older Word or OneNote, from the name and the first bytes (16 are enough).
// The extension decides when it names one of them; otherwise the bytes do,
// unless the name says the file is something else (an .xls is OLE2 too).
export function legacyOffice(name: string, head: Buffer): LegacyOffice | null {
  // A ZIP is a .docx (or an archive), whatever it is called.
  if (head[0] === 0x50 && head[1] === 0x4b) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(posix.basename(name.replaceAll("\\", "/")))?.[1]?.toLowerCase() || "";
  if (ext === "doc" || ext === "dot") return "doc";
  if (ext === "one" || ext === "onetoc2" || ext === "onepkg") return "onenote";
  // (A password-protected .docx is an OLE2 file as well: not an older one.)
  if (ext && !["zip", "bin", "dat", "tmp"].includes(ext)) return null;
  if (starts(head, ONE) || starts(head, ONETOC2) || starts(head, CAB)) return "onenote";
  if (starts(head, OLE2)) return "doc";
  return null;
}

export function refuseLegacyOffice(name: string, head: Buffer) {
  const kind = legacyOffice(name, head);
  if (kind) throw new HttpError(400, legacyRefusal(kind));
}

// Word's lock files (~$Bericht.docx) are no documents.
const isLockFile = (name: string) => posix.basename(name).startsWith("~$");

export function isWordArchive(entries: Map<string, Buffer>) {
  const names = [...entries.keys()];
  const docs = names.filter((n) => /\.docx$/i.test(n) && !isLockFile(n));
  const legacy = names.some((n) => legacyOffice(n, entries.get(n)!));
  // Google Takeout keeps Drive/ in front; HTML and Markdown belong to other sources.
  return (docs.length > 0 || legacy) && !names.some((n) => /\.(html?|md)$/i.test(n) || /^(Takeout|Drive|Google Drive)\//.test(n));
}

export function parseWord(entries: Map<string, Buffer>, name = "Microsoft Word"): ImportTree {
  const warnings = warningList();
  const files = new Map<string, ImportFile>();
  const docs: string[] = [];
  let refused: LegacyOffice | null = null;
  for (const [path, data] of entries) {
    if (isLockFile(path)) continue;
    const kind = legacyOffice(path, data);
    if (kind) {
      warnings.add(legacySkipped(posix.basename(path), kind));
      refused ??= kind;
    } else if (/\.docx$/i.test(path)) docs.push(path);
  }
  // Nothing but files Flowplan cannot read: say what to do instead.
  if (!docs.length && refused) throw new HttpError(400, legacyRefusal(refused));
  if (!docs.length) warnings.add("Keine Word-Dokumente (.docx) gefunden.");
  const pages = documentPages(entries, docs, (n) => n, files);
  return { source: "word", title: name, pages, files, warnings: warnings.list() };
}
