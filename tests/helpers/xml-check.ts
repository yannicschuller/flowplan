// A strict well-formedness check for the XML the exports write (Word parts,
// EPUB documents): balanced, properly nested tags, quoted attributes, and
// only the XML entities in text. Independent of any parser's leniency.
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
export function assertWellFormedXml(source: string, name = "document") {
  const text = source.replace(/^﻿/, "");
  const stack: string[] = [];
  let at = 0;
  const fail = (message: string): never => {
    throw new Error(`${name}: ${message} at offset ${at} (…${text.slice(Math.max(0, at - 40), at + 40)}…)`);
  };
  const checkText = (part: string) => {
    if (part.replace(ENTITY, "").includes("&")) fail("raw ampersand in text");
  };
  while (at < text.length) {
    const open = text.indexOf("<", at);
    checkText(text.slice(at, open < 0 ? text.length : open));
    if (open < 0) break;
    at = open;
    const rest = text.slice(at);
    if (rest.startsWith("<?")) {
      const end = rest.indexOf("?>");
      if (end < 0) fail("unterminated processing instruction");
      at += end + 2;
    } else if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end < 0) fail("unterminated comment");
      at += end + 3;
    } else if (rest.startsWith("<![CDATA[")) {
      const end = rest.indexOf("]]>");
      if (end < 0) fail("unterminated CDATA");
      at += end + 3;
    } else if (rest.startsWith("<!DOCTYPE")) {
      const end = rest.indexOf(">");
      if (end < 0) fail("unterminated doctype");
      at += end + 1;
    } else if (rest.startsWith("</")) {
      const match = /^<\/([^\s>]+)\s*>/.exec(rest);
      if (!match) fail("malformed closing tag");
      const expected = stack.pop();
      if (expected !== match![1]) fail(`closing </${match![1]}> but <${expected}> is open`);
      at += match![0].length;
    } else {
      const match = /^<([A-Za-z_:][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(rest);
      if (!match) fail("malformed opening tag");
      for (const value of match![2].matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) checkText(value[1] ?? value[2] ?? "");
      if (!match![3]) stack.push(match![1]);
      at += match![0].length;
    }
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1]}>`);
}
