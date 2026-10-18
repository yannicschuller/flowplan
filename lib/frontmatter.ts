// YAML frontmatter as Obsidian, Jekyll/Hugo and Logseq write it: a block
// between "---" lines at the top of a Markdown file. Only the part these
// tools use is read: keys with a value, inline lists ([a, b]), block lists
// ("- a") and one level of nested keys. Anything else stays a string.
export type FrontmatterValue = string | number | boolean | null | FrontmatterValue[] | { [key: string]: FrontmatterValue };
export type Frontmatter = Record<string, FrontmatterValue>;

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(markdown: string): { data: Frontmatter; body: string } {
  const text = markdown.replace(/^﻿/, "");
  const match = FENCE.exec(text);
  if (!match) return { data: {}, body: text };
  return { data: parseYaml(match[1]), body: text.slice(match[0].length) };
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}
// A comment starts with " #" outside of quotes.
function stripComment(raw: string) {
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i).trimEnd();
  }
  return raw.trimEnd();
}
function splitInline(raw: string) {
  const parts: string[] = [];
  let quote = "",
    current = "";
  for (const c of raw) {
    if (quote) {
      current += c;
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ",") {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}
function scalar(raw: string): FrontmatterValue {
  const text = stripComment(raw).trim();
  if (!text || text === "~" || text === "null") return null;
  if (text.startsWith("[") && text.endsWith("]")) return splitInline(text.slice(1, -1)).map(scalar);
  if (/^["']/.test(text)) return unquote(text);
  if (/^(true|yes)$/i.test(text)) return true;
  if (/^(false|no)$/i.test(text)) return false;
  if (/^-?\d+(\.\d+)?$/.test(text) && !/^-?0\d/.test(text)) return Number(text);
  return text;
}

export function parseYaml(source: string): Frontmatter {
  const lines = source.split(/\r?\n/);
  const result: Frontmatter = {};
  const keyLine = /^([^\s:#'"][^:]*?|"[^"]*"|'[^']*')\s*:(?:\s+(.*)|\s*)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#") || /^[\s-]/.test(line)) continue;
    const match = keyLine.exec(line);
    if (!match) continue;
    const key = unquote(match[1]).slice(0, 200);
    const rest = match[2] ?? "";
    if (stripComment(rest).trim() && !/^[|>][-+]?$/.test(stripComment(rest).trim())) {
      result[key] = scalar(rest);
      continue;
    }
    // Indented lines below: a block list, nested keys or a block scalar.
    const block: string[] = [];
    // (Lists may also start at the first column: "tags:" then "- a".)
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim() || /^-(\s|$)/.test(lines[i + 1])))
      block.push(lines[++i]);
    const filled = block.filter((l) => l.trim());
    if (/^[|>]/.test(stripComment(rest).trim())) {
      const indent = Math.min(...filled.map((l) => l.length - l.trimStart().length));
      const text = block.map((l) => l.slice(indent)).join("\n").replace(/\n+$/, "");
      result[key] = rest.trim().startsWith(">") ? text.replace(/(?<!\n)\n(?!\n)/g, " ") : text;
    } else if (filled.length && filled.every((l) => /^\s*-(\s|$)/.test(l)))
      result[key] = filled.map((l) => scalar(l.replace(/^\s*-\s?/, "")));
    else if (filled.length) {
      const indent = Math.min(...filled.map((l) => l.length - l.trimStart().length));
      result[key] = parseYaml(filled.map((l) => l.slice(indent)).join("\n"));
    } else result[key] = null;
  }
  return result;
}

// Strings that YAML would read as something else are quoted.
function yamlString(text: string) {
  return /^[\p{L}\p{N}][^:#\n\r\t"'[\]{},]*$/u.test(text) &&
    !/\s$/.test(text) &&
    !/^(true|false|yes|no|null|~)$/i.test(text) &&
    !/^-?\d+(\.\d+)?$/.test(text) &&
    !/^\d{4}-\d{2}-\d{2}/.test(text)
    ? text
    : JSON.stringify(text);
}
function yamlKey(key: string) {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*$/u.test(key) && !/\s$/.test(key) ? key : JSON.stringify(key);
}
function yamlValue(value: FrontmatterValue, indent: string): string {
  if (value === null) return "";
  if (typeof value === "boolean" || typeof value === "number") return ` ${value}`;
  if (typeof value === "string")
    return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value) ? ` ${value}` : ` ${yamlString(value)}`;
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => `\n${indent}  -${typeof item === "object" && item ? ` ${JSON.stringify(item)}` : yamlValue(item, indent + "  ")}`).join("")
      : " []";
  return Object.entries(value)
    .map(([k, v]) => `\n${indent}  ${yamlKey(k)}:${yamlValue(v, indent + "  ")}`)
    .join("");
}
export function toFrontmatter(data: Frontmatter) {
  const body = Object.entries(data)
    .map(([key, value]) => `${yamlKey(key)}:${yamlValue(value, "")}`)
    .join("\n");
  return `---\n${body}\n---\n`;
}
