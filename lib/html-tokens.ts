import { Tokenizer } from "htmlparser2";

// One linear pass over untrusted HTML: tags and text as they come, without a
// tree. Regular expressions over whole pages (`<tag[^>]*>[\s\S]*?</tag>`)
// and htmlparser2's Parser (its open-element stack grows with unshift) take
// quadratic time on crafted pages; the tokenizer alone does not.
// Attribute values and text stay raw (entities are not decoded); attribute
// names and tag names are lower case, the first of repeated attributes wins.
// A handler that returns `false` ends the scan.
export type HtmlTag = { name: string; attrs: ReadonlyMap<string, string> };
export type HtmlHandlers = {
  open?: (tag: HtmlTag) => void | boolean;
  close?: (name: string) => void | boolean;
  text?: (raw: string) => void | boolean;
};
const NO_ATTRIBUTES: ReadonlyMap<string, string> = new Map();
export function scanHtml(html: string, handlers: HtmlHandlers) {
  let name = "";
  let attrs: Map<string, string> | null = null;
  let attrName = "";
  let attrValue = "";
  const ignore = () => {};
  const open = () => handlers.open?.({ name, attrs: attrs ?? NO_ATTRIBUTES });
  const tokenizer: Tokenizer = new Tokenizer(
    { decodeEntities: false },
    {
      onopentagname: (start, end) => {
        name = html.slice(start, end).toLowerCase();
        attrs = null;
      },
      onattribname: (start, end) => {
        attrName = html.slice(start, end).toLowerCase();
        attrValue = "";
      },
      onattribdata: (start, end) => {
        attrValue += html.slice(start, end);
      },
      onattribend: () => {
        attrs ??= new Map();
        if (!attrs.has(attrName)) attrs.set(attrName, attrValue);
      },
      // In HTML, `<div/>` opens a <div> like `<div>`.
      onopentagend: () => {
        if (open() === false) tokenizer.pause();
      },
      onselfclosingtag: () => {
        if (open() === false) tokenizer.pause();
      },
      onclosetag: (start, end) => {
        if (handlers.close?.(html.slice(start, end).toLowerCase()) === false) tokenizer.pause();
      },
      ontext: (start, end) => {
        if (handlers.text?.(html.slice(start, end)) === false) tokenizer.pause();
      },
      onattribentity: ignore,
      ontextentity: ignore,
      oncdata: ignore,
      oncomment: ignore,
      ondeclaration: ignore,
      onprocessinginstruction: ignore,
      onend: ignore,
    },
  );
  tokenizer.write(html);
  tokenizer.end();
}

// Elements without content (no end tag).
export const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
