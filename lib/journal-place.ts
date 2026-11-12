// Where new blocks go in a journal day (#247, #250): the open tasks carried
// over into a new day (journal option `carried`) and what the workflow step
// "An Journaltag anhängen" adds (lib/workflows/nodes/journal.ts). Shared
// and pure: works on the day's top-level blocks.
import type { Node as PMNode } from "@tiptap/pm/model";

// top: before everything; end: after everything; heading: below the
// top-level heading whose text (trimmed) is `heading` – at the end when the
// day has no such heading (any more).
export type BlockPlace = { at: "top" | "end" | "heading"; heading?: string };

// The template's / day's top-level headings, for pickers: text, level.
export function headingsOf(nodes: PMNode[]) {
  const out: { text: string; level: number }[] = [];
  for (const node of nodes)
    if (node.type.name === "heading" && node.textContent.trim()) out.push({ text: node.textContent.trim(), level: Number(node.attrs.level) || 1 });
  return out;
}

// The index in `body` at which blocks are inserted. `section`: with
// "heading", "start" is directly below the heading (carried tasks come
// before whatever the template puts there), "end" at the end of the
// heading's section – before the next heading of the same or a higher
// level (entries added later stay in order).
export function placeIndex(body: PMNode[], place: BlockPlace, section: "start" | "end" = "start") {
  if (place.at === "top") return 0;
  const wanted = (place.heading || "").trim();
  const i = place.at === "heading" && wanted ? body.findIndex((n) => n.type.name === "heading" && n.textContent.trim() === wanted) : -1;
  if (i < 0) return body.length;
  if (section === "start") return i + 1;
  const level = Number(body[i].attrs.level) || 1;
  let end = i + 1;
  while (end < body.length && !(body[end].type.name === "heading" && (Number(body[end].attrs.level) || 1) <= level)) end++;
  // Empty paragraphs at the end of the section (a template's placeholder
  // lines) stay below what is added: the new text joins the section's content.
  while (end > i + 1 && body[end - 1].type.name === "paragraph" && !body[end - 1].content.size) end--;
  return end;
}

// `body` with `blocks` inserted at `place`.
export function placeBlocks(body: PMNode[], blocks: PMNode[], place: BlockPlace, section: "start" | "end" = "start") {
  if (!blocks.length) return body;
  const at = placeIndex(body, place, section);
  return [...body.slice(0, at), ...blocks, ...body.slice(at)];
}
