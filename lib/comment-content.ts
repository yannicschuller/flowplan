import { z } from "zod";
import { parsePageLocation } from "./page-location";
import { mapAsync } from "./each-async";
export type CommentMark = {
  type: "bold" | "italic" | "underline" | "strike" | "code" | "link";
  attrs?: { href: string };
};
// A file attached to a comment or reply (#450): an upload of the comment's
// page, by its address. Name, type and size are the stored file's (the
// server fills them in); `missing` (answers only) marks a file that is gone
// or in the trash.
export type CommentAttachment = {
  src: string;
  name: string;
  mime: string;
  size: number;
  missing?: boolean;
};
// The preview card of a link in the comment (#450), as GET /api/embed
// resolved it while the comment was written (lib/oembed.ts, SSRF-safe).
export type CommentLinkPreview = {
  url: string;
  title: string;
  site: string;
  description: string;
  image: string;
};
export type CommentNode = {
  type: string;
  text?: string;
  attrs?: {
    userId?: string | null;
    label?: string;
    start?: number;
    // pageMention (#450): the page or record named; `noAccess` (answers
    // only) when the reader may not read it – then without a label.
    pageId?: string;
    rowId?: string;
    noAccess?: boolean;
    // doc (#450): what the comment carries besides its text.
    attachments?: CommentAttachment[];
    previews?: CommentLinkPreview[];
  };
  marks?: CommentMark[];
  content?: CommentNode[];
};
export const MAX_COMMENT_ATTACHMENTS = 10;
export const MAX_COMMENT_PREVIEWS = 2;
const FILE_SRC = /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// The id of an attachment's file, or null for anything else.
export const attachmentFileId = (src: unknown) =>
  typeof src === "string" ? (FILE_SRC.exec(src)?.[1]?.toLowerCase() ?? null) : null;
export const commentAttachments = (content: CommentNode | null | undefined): CommentAttachment[] =>
  content?.attrs?.attachments || [];
// Whether a draft can be sent: text, or at least one attachment.
export const commentReady = (body: string, content?: CommentNode | null) =>
  !!body.trim() || commentAttachments(content).length > 0;
const httpUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};
const clipText = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
function docAttrs(v: Record<string, any>): CommentNode["attrs"] | undefined {
  const attrs: NonNullable<CommentNode["attrs"]> = {};
  const files = v.attrs?.attachments;
  if (files !== undefined && files !== null) {
    if (!Array.isArray(files) || files.length > MAX_COMMENT_ATTACHMENTS)
      throw new Error(`Höchstens ${MAX_COMMENT_ATTACHMENTS} Anhänge pro Kommentar.`);
    const seen = new Set<string>();
    attrs.attachments = files.map((f: any): CommentAttachment => {
      const id = attachmentFileId(f?.src);
      if (!id || seen.has(id)) throw new Error("Ungültiger Anhang.");
      seen.add(id);
      return {
        src: `/api/files/${id}`,
        name: clipText(f.name, 255) || "Datei",
        mime: clipText(f.mime, 200),
        size: Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : 0,
        ...(f.missing === true ? { missing: true } : {}),
      };
    });
    if (!attrs.attachments.length) delete attrs.attachments;
  }
  const previews = v.attrs?.previews;
  if (previews !== undefined && previews !== null) {
    if (!Array.isArray(previews) || previews.length > MAX_COMMENT_PREVIEWS) throw new Error("Zu viele Linkvorschauen.");
    attrs.previews = previews.map((p: any): CommentLinkPreview => {
      if (!httpUrl(p?.url)) throw new Error("Ungültige Linkvorschau.");
      const image = typeof p.image === "string" && p.image.startsWith("https://") && httpUrl(p.image) ? p.image : "";
      return {
        url: p.url,
        title: clipText(p.title, 300),
        site: clipText(p.site, 100),
        description: clipText(p.description, 300),
        image,
      };
    });
    if (!attrs.previews.length) delete attrs.previews;
  }
  return Object.keys(attrs).length ? attrs : undefined;
}
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
const inline = new Set(["text", "mention", "pageMention", "hardBreak"]);
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
    } else if (v.type === "pageMention") {
      // A page or record (#450). The label is the title when written (for
      // the plain text); answers carry the current one, or none at all.
      const pageId = z.uuid().parse(v.attrs?.pageId),
        rowId = v.attrs?.rowId == null ? undefined : z.uuid().parse(v.attrs.rowId),
        noAccess = v.attrs?.noAccess === true,
        label = typeof v.attrs?.label === "string" ? v.attrs.label.slice(0, 200) : "";
      result.attrs = { pageId, ...(rowId ? { rowId } : {}), label: noAccess ? "" : label, ...(noAccess ? { noAccess } : {}) };
    } else if (v.type !== "hardBreak") {
      if (!["doc", "listItem", ...blocks].includes(v.type))
        throw new Error("Dieses Kommentarformat wird nicht unterstützt.");
      const children = v.content === undefined ? [] : v.content;
      if (!Array.isArray(children))
        throw new Error("Ungültiger Kommentarinhalt.");
      result.content = children.map((child) => node(child, depth + 1));
      if (v.type === "doc" && depth === 0) {
        const attrs = docAttrs(v);
        if (attrs) result.attrs = attrs;
      }
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
  if (node.type === "pageMention") return "@" + (node.attrs?.label || "…");
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
// The pages and records a comment names (#450), as "<page>" or "<page>:<record>".
export function commentPageMentions(content: CommentNode | null | undefined): string[] {
  const keys = new Set<string>();
  function visit(n: CommentNode) {
    if (n.type === "pageMention" && n.attrs?.pageId) keys.add(n.attrs.rowId ? `${n.attrs.pageId}:${n.attrs.rowId}` : n.attrs.pageId);
    n.content?.forEach(visit);
  }
  if (content) visit(content);
  return [...keys];
}
// Every node, rebuilt by `map` (children first); used to resolve page
// mentions for a reader and to turn them into text for an import.
export async function mapCommentNodes(
  content: CommentNode,
  map: (node: CommentNode) => CommentNode | Promise<CommentNode>,
): Promise<CommentNode> {
  const next = content.content
    ? { ...content, content: await mapAsync(content.content, async (c) => await mapCommentNodes(c, map)) }
    : content;
  return await map(next);
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
export async function mapCommentMentions(
  content: CommentNode,
  map: (
    id: string | null,
    label: string,
  ) => { userId: string | null; label: string } | Promise<{ userId: string | null; label: string }>,
): Promise<CommentNode> {
  return {
    ...content,
    ...(content.type === "mention"
      ? {
          attrs: await map(content.attrs?.userId || null, content.attrs?.label || ""),
        }
      : {}),
    ...(content.content
      ? { content: await mapAsync(content.content, async (c) => await mapCommentMentions(c, map)) }
      : {}),
  };
}
export async function commentContentIdentity(
  content: CommentNode | null,
): Promise<string | null> {
  return content
    ? JSON.stringify(
        await mapCommentMentions(content, (userId, label) => ({
          userId,
          label: userId ? "" : label,
        })),
      )
    : null;
}
