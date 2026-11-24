// Page links as chips (#466): a link to a page, record or block (the
// /page sub-page, "@" pages, records, blocks and journal days) is one
// inline atom of the text – arrows pass it whole, Shift+arrows select it
// whole, Backspace deletes it whole, dragging moves it whole. The node
// (`pageLink`, lib/document-schema.ts) keeps the address and the text shown;
// in HTML it is the same <a href="…#page=…"> as before, marked with
// data-page-link, so everything that reads stored HTML (backlinks, search,
// publications, exports) reads it as before.
//
// Before, such links were link marks on text. Both stay readable: HTML
// anchors to pages become chips when parsed (paste, imports, Markdown),
// stored documents are converted when opened (lib/page-chip-upgrade.ts,
// chipsFromLinks), and a link mark that is left (formatting inside the
// link) works as it always did.
import { type Mark, type Node as PMNode, type NodeType } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { parsePageLocation } from "./page-location";

export const PAGE_CHIP = "pageLink";
// The longest text a chip keeps (a title, an alias, "Page › block text").
export const MAX_CHIP_TITLE = 500;

// Whether a link address is one of Flowplan's page links – relative
// ("/#page=…", "#page=…") or absolute ("https://host/#page=…") – with a
// valid page location (page, record, block, comment, element).
export function isPageChipHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length > 2000) return false;
  const value = href.trim();
  const at = value.indexOf("#page=");
  if (at < 0) return false;
  const before = value.slice(0, at);
  if (before && before !== "/" && !/^https?:\/\/[^/?#\s]+\/?$/i.test(before)) return false;
  return !!parsePageLocation(value.slice(at));
}

export const chipTitle = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_CHIP_TITLE);

type ElementLike = {
  getAttribute(name: string): string | null;
  textContent: string | null;
  children: ArrayLike<{ classList?: { contains(name: string): boolean }; textContent: string | null }>;
};
// The chip an <a> element stands for, or null when it stays a link mark:
// not a page link, no text, or formatting inside the link (bold on part
// of it …), which a chip cannot hold. Icons drawn into read-only links
// (.page-link-icon, components/page-link-icons-store.tsx) are left out.
export function chipFromElement(el: ElementLike): { href: string; title: string } | null {
  const href = el.getAttribute("href");
  if (!isPageChipHref(href)) return null;
  let text = el.textContent || "";
  for (const child of Array.from(el.children)) {
    if (child.classList?.contains("page-link-icon")) text = text.replace(child.textContent || "", "");
    else return null;
  }
  // Only text a chip keeps as it is (spaces at its ends, runs of spaces
  // or a very long text stay a link; opening the document converts it
  // without losing a character, chipsFromLinks).
  const title = chipTitle(text);
  return title && title === text ? { href: href.trim(), title } : null;
}

// A link mark that makes a chip: a page link (only that mark is dropped,
// the others go onto the chip).
const chipLink = (marks: readonly Mark[]) => marks.find((m) => m.type.name === "link" && isPageChipHref(m.attrs.href));

/**
 * Stored page links (link marks on text) as chips: every run of text in a
 * block that carries the same page link and the same other marks becomes
 * one chip with the run's text and those other marks. Runs with mixed
 * formatting stay links. Null when nothing changed.
 */
export function chipsFromLinks(doc: PMNode): PMNode | null {
  const type: NodeType | undefined = doc.type.schema.nodes[PAGE_CHIP];
  if (!type) return null;
  const runs: { from: number; to: number; nodes: PMNode[] }[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    if (!block.type.contentMatch.matchType(type)) return false;
    let run: { from: number; to: number; text: string; link: Mark; marks: readonly Mark[]; mixed: boolean } | null = null;
    const close = () => {
      if (run && !run.mixed) {
        // Spaces at the ends stay text beside the chip; the text in between
        // becomes the chip only when it keeps every character.
        const lead = /^\s*/.exec(run.text)![0],
          trail = /\s*$/.exec(run.text.slice(lead.length))![0];
        const title = run.text.slice(lead.length, run.text.length - trail.length);
        const marks = run.marks.filter((m) => m !== run!.link);
        if (title && title === chipTitle(title) && block.type.allowsMarks(marks)) {
          const schema = doc.type.schema;
          runs.push({
            from: run.from,
            to: run.to,
            nodes: [
              ...(lead ? [schema.text(lead, marks)] : []),
              type.create({ href: String(run.link.attrs.href).trim(), title }, null, marks),
              ...(trail ? [schema.text(trail, marks)] : []),
            ],
          });
        }
      }
      run = null;
    };
    block.forEach((child, offset) => {
      const link = child.isText ? chipLink(child.marks) : undefined;
      const from = blockPos + 1 + offset;
      if (!link) return close();
      if (run && run.link.eq(link) && run.to === from) {
        run.to = from + child.nodeSize;
        run.text += child.text || "";
        if (!sameMarks(run.marks, child.marks)) run.mixed = true;
        return;
      }
      close();
      run = { from, to: from + child.nodeSize, text: child.text || "", link, marks: child.marks, mixed: false };
    });
    close();
    return false;
  });
  if (!runs.length) return null;
  const tr = new Transform(doc);
  for (const run of runs.reverse()) tr.replaceWith(run.from, run.to, run.nodes);
  return tr.doc;
}
const sameMarks = (a: readonly Mark[], b: readonly Mark[]) => a.length === b.length && a.every((m, i) => m.eq(b[i]));

// The JSON content of a chip, for insertContent and the like.
export const pageChipContent = (href: string, title: string) => ({ type: PAGE_CHIP, attrs: { href, title: chipTitle(title) || title } });

// Stored HTML that still has page links as link marks: <a> to a page
// without data-page-link. Cheap enough to check on every open.
const OLD_CHIP = /<a\s(?![^>]*\bdata-page-link)[^>]*\bhref="[^"]*#page=[0-9a-f]{8}-[0-9a-f-]{27}/i;
export const hasLinkMarkChips = (html: string | null | undefined) => !!html && html.includes("#page=") && OLD_CHIP.test(html);

/**
 * The other way: chips as text with a link mark, for walkers that write
 * other formats (Word, EPUB, print, Jira …) and know links, not chips.
 * The document itself when there is none.
 */
export function linksFromChips(doc: PMNode): PMNode {
  const link = doc.type.schema.marks.link;
  if (!link) return doc;
  const chips: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === PAGE_CHIP) chips.push({ pos, node });
    return !node.isLeaf;
  });
  if (!chips.length) return doc;
  const tr = new Transform(doc);
  for (const { pos, node } of chips.reverse()) {
    const title = String(node.attrs.title || "");
    if (!title) tr.delete(pos, pos + node.nodeSize);
    else tr.replaceWith(pos, pos + node.nodeSize, doc.type.schema.text(title, link.create({ href: node.attrs.href }).addToSet(node.marks)));
  }
  return tr.doc;
}
