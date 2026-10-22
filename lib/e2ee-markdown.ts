// Markdown from the editor's document (ProseMirror JSON), in the browser:
// the decrypted export of an encrypted page never passes the server.
// Covers what the encrypted editor offers; unknown blocks keep their text.
type Mark = { type: string; attrs?: Record<string, unknown> };
export type JsonNode = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: Mark[]; content?: JsonNode[] };

const escapeText = (text: string) => text.replace(/([\\`*_[\]<>|])/g, "\\$1").replace(/^(\s*)([#>+-]|\d+\.)(?=\s)/gm, "$1\\$2");

function inline(nodes: JsonNode[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === "hardBreak") return "  \n";
      if (node.type === "encryptedFile") return fileText(node);
      if (node.type !== "text") return inline(node.content);
      const marks = node.marks || [];
      const code = marks.some((m) => m.type === "code");
      let text = code ? "`" + (node.text || "").replace(/`/g, "\u02cb") + "`" : escapeText(node.text || "");
      for (const mark of marks) {
        if (mark.type === "bold") text = `**${text}**`;
        else if (mark.type === "italic") text = `*${text}*`;
        else if (mark.type === "strike") text = `~~${text}~~`;
        else if (mark.type === "highlight") text = `==${text}==`;
        else if (mark.type === "link" && typeof mark.attrs?.href === "string") text = `[${text}](<${String(mark.attrs.href).replace(/[<>\s]/g, encodeURIComponent)}>)`;
      }
      return text;
    })
    .join("");
}
function fileText(node: JsonNode) {
  const name = String(node.attrs?.name || "file");
  return String(node.attrs?.mime || "").startsWith("image/") ? `![${escapeText(name)}](${encodeURI(name)})` : `[${escapeText(name)}](${encodeURI(name)})`;
}
const indent = (text: string, prefix: string) =>
  text
    .split("\n")
    .map((line, i) => (i === 0 ? line : line ? prefix + line : line))
    .join("\n");

function block(node: JsonNode): string {
  const children = node.content || [];
  switch (node.type) {
    case "paragraph":
      return inline(children);
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${inline(children)}`;
    case "blockquote":
      return blocks(children)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "codeBlock": {
      const source = children.map((c) => c.text || "").join("");
      const fence = "`".repeat(Math.max(3, ...(source.match(/`+/g) || []).map((r) => r.length + 1)));
      return `${fence}${String(node.attrs?.language || "")}\n${source}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    case "bulletList":
    case "orderedList":
    case "taskList":
      return children
        .map((item, index) => {
          const marker =
            node.type === "orderedList"
              ? `${(Number(node.attrs?.start) || 1) + index}.`
              : node.type === "taskList"
                ? `- [${item.attrs?.checked ? "x" : " "}]`
                : "-";
          return `${marker} ${indent(blocks(item.content || [], "\n"), " ".repeat(marker.length + 1))}`;
        })
        .join("\n");
    case "table": {
      const rows = children.map((row) => (row.content || []).map((cell) => inline((cell.content || []).flatMap((p) => p.content || [])).replace(/\n/g, " ")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] || "").join(" | ")} |`;
      return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
    }
    case "encryptedFile":
      return fileText(node);
    default:
      return children.length ? blocks(children) : "";
  }
}
function blocks(nodes: JsonNode[], separator = "\n\n") {
  return nodes.map(block).join(separator);
}

export function documentMarkdown(doc: JsonNode, title?: string) {
  const body = blocks(doc.content || []).replace(/\n{3,}/g, "\n\n").trim();
  return `${title ? `# ${escapeText(title)}\n\n` : ""}${body}\n`;
}
