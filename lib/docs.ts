// Documentation under /docs: Markdown files in content/docs, rendered on the
// server. The order and grouping of the pages lives here; each file starts
// with "# Title" and a one-line summary as its first paragraph.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Marked, type Tokens } from "marked";
import type { Locale } from "./i18n";

export type DocGroup = { title: string; pages: { slug: string; title: string }[] };

// Page order and titles in both languages. English pages live in
// content/docs/en with the same file name; a missing one falls back to
// German.
const groups: { title: [de: string, en: string]; pages: [slug: string, de: string, en: string][] }[] = [
  {
    title: ["Einstieg", "Getting started"],
    pages: [
      ["first-steps", "Erste Schritte", "First steps"],
      ["pages-and-spaces", "Seiten und Bereiche", "Pages and spaces"],
    ],
  },
  {
    title: ["Arbeiten mit Flowplan", "Working with Flowplan"],
    pages: [
      ["documents", "Dokumente und Editor", "Documents and the editor"],
      ["databases", "Datenbanken", "Databases"],
      ["views", "Ansichten", "Views"],
      ["properties-and-formulas", "Eigenschaften, Formeln und Rollups", "Properties, formulas and rollups"],
      ["forms", "Formulare", "Forms"],
      ["whiteboards", "Whiteboards", "Whiteboards"],
      ["journal", "Journal", "Journal"],
      ["collaboration", "Zusammenarbeit und Kommentare", "Collaboration and comments"],
      ["sharing", "Teilen und Veröffentlichen", "Sharing and publishing"],
      ["templates", "Vorlagen", "Templates"],
      ["search-and-notifications", "Suche, Posteingang und Push", "Search, inbox and push"],
      ["import-export-versions", "Import, Export und Versionen", "Import, export and versions"],
      ["offline-and-apps", "Offline, Web-App und Desktop", "Offline, web app and desktop"],
      ["api-and-webhooks", "API und Webhooks", "API and webhooks"],
      ["keyboard-shortcuts", "Tastenkürzel", "Keyboard shortcuts"],
    ],
  },
  {
    title: ["Verwaltung", "Administration"],
    pages: [["workspaces-and-permissions", "Arbeitsbereiche, Mitglieder und Rechte", "Workspaces, members and permissions"]],
  },
  {
    title: ["Selbst hosten", "Self-hosting"],
    pages: [
      ["installation", "Installation mit Docker", "Installation with Docker"],
      ["administration", "Administration der Instanz", "Administering the instance"],
      ["sign-in", "Anmeldung: Passwort, Passkeys und OIDC", "Sign-in: password, passkeys and OIDC"],
      ["configuration", "Konfiguration", "Configuration"],
      ["storage-and-backups", "Speicher, S3 und Sicherung", "Storage, S3 and backups"],
      ["coolify-and-proxy", "Coolify und Reverse Proxy", "Coolify and reverse proxies"],
      ["operations", "Betrieb und Fehlersuche", "Operations and troubleshooting"],
    ],
  },
];
const pick = (locale: Locale, [de, en]: [string, string]) => (locale === "en" ? en : de);
export function docGroups(locale: Locale = "de"): DocGroup[] {
  return groups.map((g) => ({
    title: pick(locale, g.title),
    pages: g.pages.map(([slug, de, en]) => ({ slug, title: pick(locale, [de, en]) })),
  }));
}
export const docSlugs = groups.flatMap((g) => g.pages.map(([slug]) => slug));

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

const callouts: Record<Locale, Record<string, string>> = {
  de: { NOTE: "Hinweis", TIP: "Tipp", WARNING: "Achtung" },
  en: { NOTE: "Note", TIP: "Tip", WARNING: "Warning" },
};

function render(markdown: string, locale: Locale) {
  const toc: TocEntry[] = [];
  const used = new Set<string>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        let id = headingId(inner) || (locale === "en" ? "section" : "abschnitt");
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
        return `<aside class="callout" data-kind="${kind.toLowerCase()}"><strong class="callout-label">${callouts[locale][kind]}</strong>${body}</aside>\n`;
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
const fileOf = (slug: string, locale: Locale) => {
  const english = join(directory(), "en", `${slug}.md`);
  return locale === "en" && existsSync(english) ? english : join(directory(), `${slug}.md`);
};

function read(slug: string, locale: Locale) {
  const text = readFileSync(fileOf(slug, locale), "utf8");
  const title = text.match(/^# (.+)$/m)?.[1]?.trim() || slug;
  const rest = text.replace(/^[\s\S]*?^# .+\n+/m, "");
  // The first paragraph is the lead, the rest the article.
  const cut = rest.search(/\n\s*\n/);
  const lead = (cut < 0 ? rest : rest.slice(0, cut)).replace(/\s+/g, " ").trim();
  return { title, lead, body: cut < 0 ? "" : rest.slice(cut) };
}

export function loadDoc(slug: string, locale: Locale = "de"): Doc | null {
  if (!docSlugs.includes(slug)) return null;
  const { title, lead, body } = read(slug, locale);
  const { html, toc } = render(body, locale);
  const leadHtml = new Marked({ gfm: true }).parseInline(lead, { async: false }) as string;
  const all = docGroups(locale);
  const pages = all.flatMap((g) => g.pages);
  const index = docSlugs.indexOf(slug);
  return {
    slug,
    title,
    summary: plain(leadHtml),
    leadHtml,
    group: all.find((g) => g.pages.some((p) => p.slug === slug))?.title || "",
    html,
    toc,
    prev: index > 0 ? pages[index - 1] : undefined,
    next: pages[index + 1],
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
export function docSearchIndex(locale: Locale = "de") {
  return docSlugs.map((slug) => {
    const doc = loadDoc(slug, locale)!;
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
