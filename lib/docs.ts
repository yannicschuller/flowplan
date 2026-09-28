// Documentation under /docs: Markdown files in content/docs, rendered on the
// server. The order and grouping of the pages lives here; each file starts
// with "# Title" and a one-line summary as its first paragraph.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked, type Tokens } from "marked";

export type DocGroup = { title: string; admin?: boolean; pages: { slug: string; title: string }[] };

// Groups marked admin describe running the instance: only signed-in
// administrators see them (navigation, search and the pages themselves).
const groups: { title: string; admin?: boolean; pages: [slug: string, title: string][] }[] = [
  {
    title: "Einstieg",
    pages: [
      ["erste-schritte", "Erste Schritte"],
      ["seiten-und-bereiche", "Seiten und Bereiche"],
    ],
  },
  {
    title: "Arbeiten mit Flowplan",
    pages: [
      ["dokumente", "Dokumente und Editor"],
      ["datenbanken", "Datenbanken"],
      ["ansichten", "Ansichten"],
      ["eigenschaften-und-formeln", "Eigenschaften, Formeln und Rollups"],
      ["formulare", "Formulare"],
      ["whiteboards", "Whiteboards"],
      ["journal", "Journal"],
      ["zusammenarbeit", "Zusammenarbeit und Kommentare"],
      ["teilen", "Teilen und Veröffentlichen"],
      ["vorlagen", "Vorlagen"],
      ["suche-und-benachrichtigungen", "Suche, Posteingang und Push"],
      ["import-export-versionen", "Import, Export und Versionen"],
      ["offline-und-apps", "Offline, Web-App und Desktop"],
      ["api-und-webhooks", "API und Webhooks"],
      ["tastenkuerzel", "Tastenkürzel"],
    ],
  },
  {
    title: "Verwaltung",
    pages: [["arbeitsbereiche-und-rechte", "Arbeitsbereiche, Mitglieder und Rechte"]],
  },
  {
    title: "Betrieb der Instanz",
    admin: true,
    pages: [
      ["administration", "Administration der Instanz"],
      ["installation", "Installation mit Docker"],
      ["anmeldung-oidc", "Anmeldung mit OIDC"],
      ["konfiguration", "Konfiguration"],
      ["speicher-und-sicherung", "Speicher, S3 und Sicherung"],
      ["coolify-und-proxy", "Coolify und Reverse Proxy"],
      ["betrieb", "Betrieb und Fehlersuche"],
    ],
  },
];

export const docGroups: DocGroup[] = groups.map((g) => ({
  title: g.title,
  ...(g.admin ? { admin: true } : {}),
  pages: g.pages.map(([slug, title]) => ({ slug, title })),
}));
export const docSlugs = docGroups.flatMap((g) => g.pages.map((p) => p.slug));
export const adminDocSlugs = new Set(docGroups.filter((g) => g.admin).flatMap((g) => g.pages.map((p) => p.slug)));
// What a reader may see: everything for administrators, the rest for all.
export const docGroupsFor = (admin: boolean) => docGroups.filter((g) => admin || !g.admin);
const slugsFor = (admin: boolean) => docGroupsFor(admin).flatMap((g) => g.pages.map((p) => p.slug));

export type TocEntry = { id: string; text: string; depth: number };
export type Doc = {
  slug: string;
  title: string;
  summary: string;
  leadHtml: string;
  group: string;
  html: string;
  toc: TocEntry[];
  prev?: { slug: string; title: string };
  next?: { slug: string; title: string };
};

export function headingId(text: string) {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const callouts: Record<string, string> = {
  NOTE: "Hinweis",
  TIP: "Tipp",
  WARNING: "Achtung",
};

function render(markdown: string) {
  const toc: TocEntry[] = [];
  const used = new Set<string>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        let id = headingId(inner) || "abschnitt";
        for (let n = 2; used.has(id); n++) id = `${headingId(inner)}-${n}`;
        used.add(id);
        if (depth === 2 || depth === 3) toc.push({ id, text: plain(inner), depth });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const external = /^https?:\/\//.test(href);
        return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ""}${
          external ? ' target="_blank" rel="noreferrer"' : ""
        }>${inner}</a>`;
      },
      code({ text, lang }: Tokens.Code) {
        const language = (lang || "").split(/\s/)[0];
        return `<div class="code" data-lang="${escape(language)}"><pre><code>${escape(text)}</code></pre></div>\n`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        let body = this.parser.parse(tokens);
        const match = body.match(/^<p>\[!(NOTE|TIP|WARNING)\]\s*/);
        if (!match) return `<blockquote>${body}</blockquote>\n`;
        body = body.replace(match[0], "<p>");
        const kind = match[1];
        return `<aside class="callout" data-kind="${kind.toLowerCase()}"><strong class="callout-label">${callouts[kind]}</strong>${body}</aside>\n`;
      },
      table(token: Tokens.Table) {
        const head = token.header
          .map((cell) => `<th${cell.align ? ` style="text-align:${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</th>`)
          .join("");
        const rows = token.rows
          .map(
            (row) =>
              `<tr>${row
                .map((cell) => `<td${cell.align ? ` style="text-align:${cell.align}"` : ""}>${this.parser.parseInline(cell.tokens)}</td>`)
                .join("")}</tr>`,
          )
          .join("");
        return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  const html = marked.parse(markdown, { async: false }) as string;
  return { html, toc };
}

const directory = () => join(process.cwd(), "content", "docs");

function read(slug: string) {
  const text = readFileSync(join(directory(), `${slug}.md`), "utf8");
  const title = text.match(/^# (.+)$/m)?.[1]?.trim() || slug;
  const rest = text.replace(/^[\s\S]*?^# .+\n+/m, "");
  // The first paragraph is the lead, the rest the article.
  const cut = rest.search(/\n\s*\n/);
  const lead = (cut < 0 ? rest : rest.slice(0, cut)).replace(/\s+/g, " ").trim();
  return { title, lead, body: cut < 0 ? "" : rest.slice(cut) };
}

export function loadDoc(slug: string, admin = adminDocSlugs.has(slug)): Doc | null {
  if (!docSlugs.includes(slug)) return null;
  // Previous and next only lead to pages this reader may open.
  const order = slugsFor(admin);
  const { title, lead, body } = read(slug);
  const { html, toc } = render(body);
  const leadHtml = new Marked({ gfm: true }).parseInline(lead, { async: false }) as string;
  const index = order.indexOf(slug);
  const find = (s: string | undefined) =>
    s ? docGroups.flatMap((g) => g.pages).find((p) => p.slug === s) : undefined;
  return {
    slug,
    title,
    summary: plain(leadHtml),
    leadHtml,
    group: docGroups.find((g) => g.pages.some((p) => p.slug === slug))?.title || "",
    html,
    toc,
    prev: index > 0 ? find(order[index - 1]) : undefined,
    next: index >= 0 ? find(order[index + 1]) : find(order[0]),
  };
}

// Plain text of a rendered part; block ends become spaces so table cells
// and list items do not run together.
const blockText = (html: string) =>
  plain(html.replace(/<\/(p|li|td|th|tr|h\d|div|pre|aside|blockquote)>/g, " $&"))
    .replace(/\s+/g, " ")
    .trim();

// Search index: every page with its sections and their plain text, so the
// search box also finds words that only appear in the body.
export function docSearchIndex(admin = false) {
  return slugsFor(admin).map((slug) => {
    const doc = loadDoc(slug, admin)!;
    const parts = doc.html.split(/(?=<h[23] id=")/);
    const intro = parts[0].startsWith("<h") ? "" : parts.shift()!;
    return {
      slug,
      title: doc.title,
      group: doc.group,
      summary: doc.summary,
      text: blockText(intro),
      sections: parts.map((part) => {
        const id = part.match(/^<h[23] id="([^"]+)"/)![1];
        const heading = plain(part.slice(0, part.indexOf("</h")).replace(/<a class="anchor"[^>]*>#<\/a>/, ""));
        return {
          id,
          text: heading.trim(),
          body: blockText(part.slice(part.indexOf("</h") + 5)),
        };
      }),
    };
  });
}
export type DocSearchEntry = ReturnType<typeof docSearchIndex>[number];
