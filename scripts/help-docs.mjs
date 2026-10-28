// The Flowplan help for "Ask AI" (lib/ai/help.ts): the documentation of
// docs.flowplan.org, German and English, split into sections and written to
// lib/ai/help-docs.json – part of the app, so answers about Flowplan need no
// outside request and always match the installed version.
//
//   npm run help-docs                       # ../flowplan-docs next to this repository
//   FLOWPLAN_DOCS_DIR=/path/to/flowplan-docs npm run help-docs
//
// Each section: the page (slug and title), the heading and its anchor (as
// docs.flowplan.org builds it, lib/docs.ts headingId there) and the text as
// paragraphs without Markdown, images or HTML.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = resolve(
  process.env.FLOWPLAN_DOCS_DIR || join(root, "..", "flowplan-docs"),
  "content",
  "docs",
);
const out = join(root, "lib", "ai", "help-docs.json");

const headingId = (text) =>
  text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Markdown to plain text: links keep their words, images, HTML and
// emphasis go.
const inline = (text) =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

function sections(slug, markdown) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const title = inline(
    (lines.find((l) => l.startsWith("# ")) || `# ${slug}`).slice(2),
  );
  const list = [];
  const used = new Set();
  let current = { slug, page: title, heading: "", anchor: "", paragraphs: [] };
  let paragraph = [];
  let fence = false;
  const flush = () => {
    const text = inline(paragraph.join(" "));
    if (text) current.paragraphs.push(text);
    paragraph = [];
  };
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      flush();
      continue;
    }
    if (fence) {
      // Code (commands, settings) stays, one line each.
      if (line.trim()) current.paragraphs.push(line.trim());
      continue;
    }
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      if (current.paragraphs.length) list.push(current);
      const text = inline(heading[2]);
      let anchor = headingId(
        heading[2]
          .replace(/\*\*|`/g, "")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"),
      );
      for (let n = 2; used.has(anchor); n++) anchor = `${headingId(text)}-${n}`;
      used.add(anchor);
      // Level-4 headings stay inside their section.
      if (heading[1].length === 4) {
        current.paragraphs.push(text);
        continue;
      }
      current = { slug, page: title, heading: text, anchor, paragraphs: [] };
      continue;
    }
    if (line.startsWith("# ")) continue;
    if (!line.trim() || /^\s*[-*+]\s|^\s*\d+\.\s|^\s*\|/.test(line)) flush();
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue;
    if (line.trim())
      paragraph.push(
        line
          .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "– ")
          .replace(/^>\s?/, "")
          .replace(/\|/g, " "),
      );
  }
  flush();
  if (current.paragraphs.length) list.push(current);
  return list;
}

const result = {};
for (const [locale, dir] of [
  ["de", docs],
  ["en", join(docs, "en")],
]) {
  result[locale] = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) =>
      sections(f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")),
    );
}
writeFileSync(out, JSON.stringify(result) + "\n");
console.log(
  `help-docs: ${result.de.length} sections (de), ${result.en.length} (en) → lib/ai/help-docs.json`,
);
