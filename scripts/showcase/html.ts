// Small builders for document HTML as Flowplan stores it (lib/document-schema.ts).
import { randomUUID } from "node:crypto";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const attr = (value: unknown) => esc(typeof value === "string" ? value : JSON.stringify(value));

export const h = (level: 1 | 2 | 3, text: string) => `<h${level}>${text}</h${level}>`;
export const p = (html: string) => `<p>${html}</p>`;
export const ul = (...items: string[]) => `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</ul>`;
export const ol = (...items: string[]) => `<ol>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</ol>`;
export const quote = (html: string) => `<blockquote><p>${html}</p></blockquote>`;
export const hr = () => "<hr>";
export const callout = (type: "note" | "tip" | "important" | "warning" | "caution", ...paragraphs: string[]) =>
  `<aside data-callout="${type}">${paragraphs.map((x) => (x.startsWith("<") ? x : p(x))).join("")}</aside>`;
export const toggle = (summary: string, body: string) => `<details><summary>${summary}</summary><div>${body}</div></details>`;
export const columns = (...cols: string[]) => `<div data-columns="true">${cols.map((c) => `<div data-column="true">${c}</div>`).join("")}</div>`;
export const table = (rows: string[][], header = true) =>
  `<table><tbody>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 && header ? `<th><p>${c}</p></th>` : `<td><p>${c}</p></td>`)).join("")}</tr>`).join("")}</tbody></table>`;
export const code = (lang: string, source: string) => `<pre><code class="language-${lang}">${esc(source)}</code></pre>`;
export const mermaid = (source: string) => `<div data-mermaid="${esc(source)}" class="mermaid-block"></div>`;
export const math = (tex: string) => `<div data-math="${esc(tex)}" class="math-block"></div>`;
export const mathInline = (tex: string) => `<span data-math="${esc(tex)}" class="math-inline"></span>`;
export const plot = (functions: { expr: string; color: string }[], view?: { xMin: number; xMax: number; yMin: number; yMax: number }) =>
  `<div data-function-plot="${attr({ functions, view: view ?? null })}" class="function-plot"></div>`;
export const metric = (source: string, aggregate: string, field = "", view = "") => `<div data-metric="${attr({ source, view, aggregate, field })}" class="metric-block"></div>`;
export const link = (pageId: string, text: string, rowId?: string) => `<a href="/#page=${pageId}${rowId ? `&amp;row=${rowId}` : ""}">${text}</a>`;
export const web = (url: string, text: string) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
export const mention = (userId: string, name: string) => `<span data-mention="${esc(userId)}" class="mention">@${esc(name)}</span>`;
export const footnote = (note: string) => `<sup data-footnote="${esc(note)}" class="footnote-ref"></sup>`;
export const spoiler = (text: string) => `<span data-spoiler="true">${text}</span>`;
export const mark = (text: string, color = "#fff3bf") => `<mark data-color="${color}" style="background-color:${color}">${text}</mark>`;
export const color = (text: string, value: string) => `<span style="color:${value}">${text}</span>`;
export type Csl = { id: string; type: string; title: string; author: { family: string; given: string }[]; issued: { "date-parts": number[][] }; publisher?: string; "container-title"?: string };
export const citation = (item: Csl, locator = "") =>
  `<span class="citation" data-citation="${esc(item.id)}" data-citation-item="${attr(item)}" data-citation-locator="${esc(locator)}"></span>`;
export const bibliography = (title: string) => `<div data-bibliography="true" data-bibliography-title="${esc(title)}"></div>`;
export const linkCard = (url: string, title: string, provider: string, description: string) =>
  `<div data-link-card="${esc(url)}" data-link-title="${esc(title)}" data-link-provider="${esc(provider)}" data-link-description="${esc(description)}" data-link-image=""></div>`;
export const embed = (src: string) => `<iframe src="${esc(src)}"></iframe>`;
export const image = (fileId: string, alt = "", width?: number) => `<img src="/api/files/${fileId}" alt="${esc(alt)}"${width ? ` style="width: ${width}%"` : ""}>`;
export const pdf = (fileId: string, title: string) => `<div data-pdf="/api/files/${fileId}" data-title="${esc(title)}" class="pdf-block"><a href="/api/files/${fileId}">${esc(title)}</a></div>`;
export const synced = (pageId: string) => `<div data-synced-block="${pageId}"></div>`;
export const whiteboard = (pageId: string, height = 420) => `<div data-whiteboard="${pageId}" data-whiteboard-height="${height}"></div>`;
export const drawBlock = (id: string, height: number, paper: "blank" | "lined" | "grid") => `<div data-ink-block="${id}" data-ink-height="${height}" data-ink-paper="${paper}" class="ink-block-placeholder">Handschrift</div>`;
export const linkedDatabase = (source: string, views: unknown[]) =>
  `<div data-linked-database="${randomUUID()}" data-linked-source="${source}" data-linked-views="${attr(views)}" data-linked-version="1"></div>`;
export type Task = { text: string; done?: boolean; due?: string; who?: { id: string; name: string }; children?: Task[] };
export const tasks = (...items: Task[]): string =>
  `<ul data-type="taskList">${items
    .map(
      (t) =>
        `<li data-type="taskItem" data-checked="${!!t.done}"${t.due ? ` data-due="${t.due}"` : ""}><label><input type="checkbox"${t.done ? " checked" : ""}></label><div><p>${t.text}${t.who ? ` ${mention(t.who.id, t.who.name)}` : ""}</p>${t.children?.length ? tasks(...t.children) : ""}</div></li>`,
    )
    .join("")}</ul>`;
export const reactions = (html: string, map: Record<string, string[]>) => `<p data-reactions='${JSON.stringify(map)}'>${html}</p>`;
export const suggestion = (kind: "insert" | "delete", text: string, author: { id: string; name: string }, sid: string, at: number) =>
  `<span data-suggestion="${kind}" data-suggestion-id="${sid}" data-suggestion-author="${esc(author.id)}" data-suggestion-name="${esc(author.name)}" data-suggestion-at="${at}">${text}</span>`;
