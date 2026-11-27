// A synthetic Obsidian vault as a ZIP (#594): nested folders and folder
// notes, notes with frontmatter (tags, aliases, properties), headings,
// wikilinks to notes, headings and blocks, tasks, callouts, code, inline
// tags and embedded images and PDFs. Deterministic for a given size, so
// the benchmark (scripts/bench-import.ts) and the snapshot test
// (tests/import-snapshot.test.ts) see the same vault every time.
import { writeZip } from "../../lib/archive";
import { diagramPng } from "./png";

export type VaultSize = { notes: number; images: number; pdfs?: number };

// A small seeded PRNG (mulberry32): the same vault on every run.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "Plan Idee Projekt Notiz Termin Aufgabe Liste Bericht Entwurf Ziel Thema Quelle Frage Antwort Übersicht Kapitel".split(" ");
const TAGS = Array.from({ length: 30 }, (_, i) => `tag-${i}`);

const pdf = (n: number) =>
  Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n% ${n}\ntrailer<</Root 1 0 R>>\n%%EOF\n`);

export function vaultEntries({ notes, images, pdfs = Math.round(images / 10) }: VaultSize): Map<string, Buffer> {
  const rnd = random(594);
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)];
  const entries = new Map<string, Buffer>();
  entries.set(".obsidian/app.json", Buffer.from("{}"));
  // Folders: up to three levels, some with a folder note.
  const folders: string[] = [""];
  for (let a = 0; a < 8; a++) {
    folders.push(`Bereich ${a}`);
    for (let b = 0; b < 4; b++) {
      folders.push(`Bereich ${a}/Thema ${b}`);
      if ((a + b) % 3 === 0) for (let c = 0; c < 2; c++) folders.push(`Bereich ${a}/Thema ${b}/Teil ${c}`);
    }
  }
  // Images: small PNGs of a few sizes (each file different); some PDFs.
  const imageNames: string[] = [];
  for (let i = 0; i < images; i++) {
    const name = `Anhänge/${i % 5 === 0 ? "Bilder/" : ""}bild-${i}.png`;
    entries.set(name, diagramPng(16 + (i % 7), 12 + (i % 5)));
    imageNames.push(name.split("/").pop()!);
  }
  const pdfNames: string[] = [];
  for (let i = 0; i < pdfs; i++) {
    entries.set(`Anhänge/dokument-${i}.pdf`, pdf(i));
    pdfNames.push(`dokument-${i}.pdf`);
  }
  // Notes: their names first, so that links can point forward.
  const names = Array.from({ length: notes }, (_, i) => `${pick(WORDS)} ${i}`);
  const paths = names.map((name, i) => {
    const folder = folders[i % folders.length];
    // Folder notes ("Folder/Folder.md") for some folders.
    if (folder && i < folders.length && i % 4 === 1) return `${folder}/${folder.split("/").pop()}.md`;
    return folder ? `${folder}/${name}.md` : `${name}.md`;
  });
  const title = (i: number) => paths[i].split("/").pop()!.replace(/\.md$/, "");
  let image = 0;
  paths.forEach((path, i) => {
    const lines: string[] = [];
    // Frontmatter on most notes.
    if (i % 5 !== 4) {
      lines.push("---");
      lines.push(`tags: [${pick(TAGS)}, ${pick(TAGS)}]`);
      if (i % 3 === 0) lines.push(`aliases: [Alias ${i}]`);
      if (i % 2 === 0) lines.push(`status: ${pick(["offen", "fertig", "in Arbeit"])}`);
      if (i % 4 === 0) lines.push(`rating: ${1 + (i % 5)}`);
      if (i % 6 === 0) lines.push(`due: 2026-0${1 + (i % 9)}-1${i % 10}`);
      lines.push("---");
    }
    lines.push(`# ${title(i)}`, "");
    const sections = 2 + (i % 4);
    for (let s = 0; s < sections; s++) {
      lines.push(`## Abschnitt ${s}`, "");
      const other = Math.floor(rnd() * notes);
      lines.push(
        `Text über ${pick(WORDS)} mit **fett**, _kursiv_ und einem Link auf [[${title(other)}]], ` +
          `auf [[${title(Math.floor(rnd() * notes))}#Abschnitt 1|einen Abschnitt]] und #${pick(TAGS)} im Text.`,
        "",
      );
      if (s === 0 && i % 7 === 0) lines.push(`Ein Block mit Kennung. ^block-${i}`, "");
      if (s === 1 && i % 7 === 3) lines.push(`Siehe [[${title(i - 3)}#^block-${i - 3}]] und [[Fehlt ${i}]].`, "");
      if (s === 1) lines.push(`- [ ] Aufgabe ${i}.${s}`, `- [x] Erledigt ${i}.${s}`, `- Punkt mit [[${title((i + 1) % notes)}]]`, "");
      if (s === 2 && i % 3 === 0) lines.push("> [!note] Hinweis", `> Callout in ${title(i)}`, "");
      if (s === 2 && i % 5 === 0) lines.push("```js", `const n = ${i}; // [[kein Link]] #kein-tag`, "```", "");
      if (images && (i * 7 + s) % Math.max(1, Math.round((notes * sections) / Math.max(1, images * 1.3))) === 0)
        lines.push(`![[${imageNames[image++ % imageNames.length]}]]`, "");
    }
    if (pdfs && i % Math.max(1, Math.round(notes / pdfs)) === 0) lines.push(`![[${pdfNames[(i / Math.max(1, Math.round(notes / pdfs))) % pdfNames.length]}]]`, "");
    entries.set(path, Buffer.from(lines.join("\n")));
  });
  return entries;
}

export const vaultZip = (size: VaultSize) => writeZip(vaultEntries(size));
