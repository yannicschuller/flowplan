// Names of ZIP entries and the names that refer to them (#556).
//
// The ZIP format knows two encodings for a name: UTF-8 when general-purpose
// bit 11 is set (or an Info-ZIP Unicode Path extra field 0x7075 carries it),
// CP437 otherwise. yauzl decodes exactly that – but macOS (Finder, Archive
// Utility, its Info-ZIP `zip`) writes raw UTF-8 without bit 11, so a name
// like "Diárias" came out as "Dia╠ürias". Like Info-ZIP's unzip and 7-Zip,
// a name without bit 11 or Unicode Path field is therefore taken as UTF-8
// when its bytes are valid UTF-8, and as CP437 only otherwise.
//
// macOS also writes names decomposed (NFD: "a" + combining acute) while the
// text of notes is composed (NFC). Every name is normalised to NFC – for
// Flowplan's own archives (ASCII or NFC UTF-8 names) that changes nothing –
// and importers compare the names in links through `nameKey`.
import { getFileNameLowLevel, validateFileName, type Entry } from "yauzl";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The entry's name as UTF-8/CP437 by the rules above, in NFC. Throws for
// names yauzl's own check refuses (absolute paths, "..", backslashes).
export function zipEntryName(entry: Pick<Entry, "fileName" | "fileNameRaw" | "generalPurposeBitFlag">) {
  let name = entry.fileName;
  // yauzl's name came from neither bit 11 nor a Unicode Path field when it
  // equals the plain CP437 reading of the raw bytes.
  if (!(entry.generalPurposeBitFlag & 0x800) && name === getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, [], true))
    try {
      name = utf8.decode(entry.fileNameRaw);
    } catch {
      // Not UTF-8: CP437 it is.
    }
  name = name.normalize("NFC");
  const problem = validateFileName(name);
  if (problem) throw new Error(problem);
  return name;
}

// A name as a lookup key: NFC (links typed as NFC or NFD find the same
// file) and lower case.
export const nameKey = (name: string) => name.normalize("NFC").toLowerCase();
// A percent-encoded path from a link, decoded and in NFC.
export const decodeName = (href: string) => decodeURIComponent(href).normalize("NFC");
