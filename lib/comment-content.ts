import { z } from "zod";
import { parsePageLocation } from "./page-location";
export type CommentMark = {
  type: "bold" | "italic" | "underline" | "strike" | "code" | "link";
  attrs?: { href: string };
};
export type CommentNode = {
  type: string;
  text?: string;
  attrs?: { userId?: string | null; label?: string; start?: number };
  marks?: CommentMark[];
  content?: CommentNode[];
};
const marks = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
]);
const blocks = new Set([
  "paragraph",
  "blockquote",
  "bulletList",
  "orderedList",
  "codeBlock",
]);
const inline = new Set(["text", "mention", "hardBreak"]);
export function safeCommentLink(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return false;
  if (value.startsWith("/#")) return !!parsePageLocation(value.slice(1));
  try {
    const url = new URL(value);
    return (
      ["http:", "https:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
/** Rebuild a small, bounded document; unknown attributes never reach rendering. */
export function normalizeCommentContent(input: unknown): CommentNode {
  if (JSON.stringify(input)?.length > 40000)
    throw new Error("Der formatierte Kommentar ist zu groß.");
  let count = 0;
  function node(value: unknown, depth: number): CommentNode {
    if (
      depth > 12 ||
      ++count > 1500 ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      throw new Error("Ungültige Kommentarstruktur.");
    const v = value as Record<string, any>;
    if (typeof v.type !== "string")
      throw new Error("Ungültiger Kommentarblock.");
    const result: CommentNode = { type: v.type };
    if (v.type === "text") {
      if (typeof v.text !== "string" || !v.text.length)
        throw new Error("Ungültiger Kommentartext.");
      result.text = v.text;
    } else if (v.type === "mention") {
      if (
        typeof v.attrs?.label !== "string" ||
        !v.attrs.label.trim() ||
        v.attrs.label.length > 200
      )
        throw new Error("Ungültige Erwähnung.");
      result.attrs = {
        userId: v.attrs.userId === null ? null : z.uuid().parse(v.attrs.userId),
        label: v.attrs.label,
      };
    } else if (v.type !== "hardBreak") {
      if (!["doc", "listItem", ...blocks].includes(v.type))
        throw new Error("Dieses Kommentarformat wird nicht unterstützt.");
      const children = v.content === undefined ? [] : v.content;
      if (!Array.isArray(children))
        throw new Error("Ungültiger Kommentarinhalt.");
      result.content = children.map((child) => node(child, depth + 1));
      if (v.type === "orderedList")
        result.attrs = {
          start: z
            .number()
            .int()
            .min(1)
            .max(1000000)
            .parse(v.attrs?.start ?? 1),
        };
      const allowed =
        v.type === "paragraph"
          ? inline
          : v.type === "codeBlock"
            ? new Set(["text"])
            : ["bulletList", "orderedList"].includes(v.type)
              ? new Set(["listItem"])
              : blocks;
      if (
        result.content.some((c) => !allowed.has(c.type)) ||
        (v.type !== "paragraph" &&
          v.type !== "codeBlock" &&
          !result.content.length) ||
        (v.type === "listItem" && result.content[0]?.type !== "paragraph")
      )
        throw new Error("Ungültige Kommentarverschachtelung.");
    }
    if (v.marks?.length) {
      if (!inline.has(v.type) || !Array.isArray(v.marks) || v.marks.length > 6)
        throw new Error("Ungültige Formatierung.");
      result.marks = v.marks
        .map((m: any): CommentMark => {
          if (!m || !marks.has(m.type))
            throw new Error("Unbekannte Formatierung.");
          if (m.type === "link") {
            if (!safeCommentLink(m.attrs?.href))
              throw new Error(
                "Bitte einen gültigen HTTP-, HTTPS- oder E-Mail-Link verwenden.",
              );
            return { type: "link", attrs: { href: m.attrs.href } };
          }
          return { type: m.type };
        })
        .sort((a: CommentMark, b: CommentMark) => a.type.localeCompare(b.type));
      if (
        new Set(result.marks!.map((m) => m.type)).size !== result.marks!.length
      )
        throw new Error("Doppelte Formatierung.");
    }
    return result;
  }
  const result = node(input, 0);
  if (result.type !== "doc" || commentText(result).length > 5000)
    throw new Error("Kommentare dürfen maximal 5.000 Zeichen enthalten.");
  return result;
}
export function commentText(node: CommentNode): string {
  if (node.type === "text") return node.text || "";
  if (node.type === "mention") return "@" + node.attrs?.label;
  if (node.type === "hardBreak") return "\n";
  return (node.content || [])
    .map(commentText)
    .join(["paragraph", "codeBlock"].includes(node.type) ? "" : "\n");
}
export const richCommentSchema = z.unknown().transform((value, ctx) => {
  try {
    return normalizeCommentContent(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
export function plainCommentContent(body: string): CommentNode {
  return {
    type: "doc",
    content: body.split("\n").map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    })),
  };
}
export function commentMentions(content: CommentNode | null): string[] {
  const ids = new Set<string>();
  function visit(n: CommentNode) {
    if (n.type === "mention" && n.attrs?.userId) ids.add(n.attrs.userId);
    n.content?.forEach(visit);
  }
  if (content) visit(content);
  return [...ids];
}
export function mapCommentMentions(
  content: CommentNode,
  map: (
    id: string | null,
    label: string,
  ) => { userId: string | null; label: string },
): CommentNode {
  return {
    ...content,
    ...(content.type === "mention"
      ? {
          attrs: map(content.attrs?.userId || null, content.attrs?.label || ""),
        }
      : {}),
    ...(content.content
      ? { content: content.content.map((c) => mapCommentMentions(c, map)) }
      : {}),
  };
}
export function commentContentIdentity(
  content: CommentNode | null,
): string | null {
  return content
    ? JSON.stringify(
        mapCommentMentions(content, (userId, label) => ({
          userId,
          label: userId ? "" : label,
        })),
      )
    : null;
}
