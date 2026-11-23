"use client";
// How a comment reads (page, record and text comments, #314/#450): its
// formatted text with people and pages mentioned, then its attachments and
// link previews. Light on purpose – the composer (comment-composer.tsx,
// with the editor) loads only to write.
//
// - A page mention is a link to the page or record ("/#page=…"): the
//   app's link handling opens it (⌘/Ctrl-click: a new tab) and shows its
//   hover card (components/link-preview.tsx); the icon is the page's own
//   (#96). Pages the reader may not read show "Kein Zugriff" only.
// - Images open in the image viewer, PDFs in the PDF viewer, videos play
//   in place; other files are chips with name and size (a download).
// - Links in plain comments (older ones, the API) become links as well.
import { createElement, useState, type ReactNode } from "react";
import { DownloadSimple, File as FileIcon, FilePdf, Lock, Paperclip } from "@phosphor-icons/react";
import { LinkTargetIcon } from "./page-link-icons-store";
import { ImageViewer } from "./image-viewer";
import { openPdf, PdfThumbnail } from "./pdf-viewer";
import { useT } from "./i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { pageLocationHash } from "@/lib/page-location";
import {
  commentAttachments,
  safeCommentLink,
  type CommentAttachment,
  type CommentLinkPreview,
  type CommentNode,
} from "@/lib/comment-content";

export function fileSizeText(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(LOCALE_TAG, { maximumFractionDigits: unit && value < 10 ? 1 : 0 }).format(value)} ${units[unit]}`;
}
export const attachmentKind = (a: Pick<CommentAttachment, "mime" | "name">) =>
  a.mime.startsWith("image/") && a.mime !== "image/svg+xml"
    ? "image"
    : a.mime.startsWith("video/")
      ? "video"
      : a.mime === "application/pdf" || /\.pdf$/i.test(a.name)
        ? "pdf"
        : "file";

// http(s) addresses in plain text, without trailing punctuation.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
function linkified(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(/[).,;:!?\]]+$/, "");
    const at = match.index!;
    if (!safeCommentLink(url)) continue;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a key={at} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    last = at + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function CommentBody({
  content,
  body,
}: {
  content?: CommentNode | null;
  body: string;
}) {
  const t = useT();
  function render(node: CommentNode, index: number): ReactNode {
    let child: ReactNode =
      node.type === "text" ? node.text : (node.content || []).map(render);
    if (node.type === "mention")
      child = (
        <span
          className="comment-mention"
          data-comment-mention={node.attrs?.userId || undefined}
          title={
            node.attrs?.userId ? t("Erwähnte Person", "Mentioned person") : t("Historische Erwähnung", "Historic mention")
          }
        >
          @{node.attrs?.label}
        </span>
      );
    if (node.type === "pageMention" && node.attrs?.pageId) {
      const href = `/${pageLocationHash({ pageId: node.attrs.pageId, rowId: node.attrs.rowId })}`;
      child = node.attrs.noAccess ? (
        <span className="comment-page-mention no-access" title={t("Diese Seite darfst du nicht lesen.", "You may not read this page.")}>
          <Lock size={12} aria-hidden="true" />
          {t("Kein Zugriff", "No access")}
        </span>
      ) : (
        <a className="comment-page-mention" href={href} data-comment-page={node.attrs.pageId}>
          <LinkTargetIcon href={href} />
          {node.attrs.label || t("Ohne Titel", "Untitled")}
        </a>
      );
    }
    if (node.type === "hardBreak") child = <br />;
    for (const mark of node.marks || []) {
      if (mark.type === "link") {
        if (safeCommentLink(mark.attrs?.href))
          child = (
            <a href={mark.attrs.href} target="_blank" rel="noopener noreferrer">
              {/* A page or record: its own icon (#96). */}
              <LinkTargetIcon href={mark.attrs.href} />
              {child}
            </a>
          );
      } else {
        const tags = {
          bold: "strong",
          italic: "em",
          underline: "u",
          strike: "s",
          code: "code",
        };
        child = createElement(tags[mark.type] || "span", null, child);
      }
    }
    if (["text", "mention", "pageMention", "hardBreak"].includes(node.type))
      return <span key={index}>{child}</span>;
    if (node.type === "codeBlock")
      return (
        <pre key={index}>
          <code>{child}</code>
        </pre>
      );
    const tags: Record<string, string> = {
      doc: "div",
      paragraph: "p",
      blockquote: "blockquote",
      bulletList: "ul",
      orderedList: "ol",
      listItem: "li",
    };
    return createElement(
      tags[node.type] || "div",
      {
        key: index,
        ...(node.type === "orderedList" ? { start: node.attrs?.start } : {}),
      },
      child,
    );
  }
  const files = commentAttachments(content);
  const previews = content?.attrs?.previews || [];
  const empty = !body.trim() && files.length > 0;
  return (
    <div className="comment-rich-body">
      {content ? !empty && render(content, 0) : body && <p>{linkified(body)}</p>}
      {files.length > 0 && <CommentFiles files={files} />}
      {previews.length > 0 && <CommentPreviews previews={previews} />}
    </div>
  );
}

// The attachments of a comment (or of a draft, with `onRemove`).
export function CommentFiles({
  files,
  onRemove,
  pending = [],
}: {
  files: CommentAttachment[];
  onRemove?: (index: number) => void;
  // Drafts: files still uploading (their names), shown after the others.
  pending?: string[];
}) {
  const t = useT();
  const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);
  const remove = (index: number, name: string) =>
    onRemove && (
      <button
        type="button"
        className="icon-button comment-file-remove"
        aria-label={t(`Anhang entfernen: ${name}`, `Remove attachment: ${name}`)}
        title={t("Entfernen", "Remove")}
        onClick={() => onRemove(index)}
      >
        ×
      </button>
    );
  return (
    <div className="comment-files" role="list" aria-label={t(`${files.length} Anhänge`, `${files.length} attachments`)}>
      {files.map((file, index) => {
        const kind = attachmentKind(file);
        const size = file.size ? fileSizeText(file.size) : "";
        if (file.missing)
          return (
            <span className="comment-file missing" role="listitem" key={file.src}>
              <FileIcon size={16} aria-hidden="true" />
              <span className="comment-file-name">{file.name}</span>
              <small>{t("Nicht mehr verfügbar", "No longer available")}</small>
              {remove(index, file.name)}
            </span>
          );
        if (kind === "image")
          return (
            <span className="comment-file comment-file-image" role="listitem" key={file.src}>
              <button
                type="button"
                className="comment-file-thumb"
                aria-label={t(`Bild öffnen: ${file.name}`, `Open image: ${file.name}`)}
                title={file.name}
                onClick={() => setViewer({ src: file.src, alt: file.name })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={file.src} alt={file.name} loading="lazy" decoding="async" />
              </button>
              {remove(index, file.name)}
            </span>
          );
        if (kind === "video")
          return (
            <span className="comment-file comment-file-video" role="listitem" key={file.src}>
              <video src={file.src} controls preload="metadata" aria-label={file.name} />
              {remove(index, file.name)}
            </span>
          );
        if (kind === "pdf")
          return (
            <span className="comment-file comment-file-pdf" role="listitem" key={file.src}>
              <button
                type="button"
                className="comment-file-thumb"
                aria-label={t(`PDF öffnen: ${file.name}`, `Open PDF: ${file.name}`)}
                title={file.name}
                onClick={() => openPdf(file.src, file.name)}
              >
                <PdfThumbnail src={file.src} width={120} />
                <span className="comment-file-caption">
                  <FilePdf size={14} aria-hidden="true" />
                  <span className="comment-file-name">{file.name}</span>
                </span>
              </button>
              {remove(index, file.name)}
            </span>
          );
        return (
          <span className="comment-file" role="listitem" key={file.src}>
            <a className="comment-file-chip" href={file.src} download={file.name} title={t(`${file.name} herunterladen`, `Download ${file.name}`)}>
              <Paperclip size={16} aria-hidden="true" />
              <span className="comment-file-name">{file.name}</span>
              {size && <small>{size}</small>}
              <DownloadSimple size={14} aria-hidden="true" />
            </a>
            {remove(index, file.name)}
          </span>
        );
      })}
      {pending.map((name, index) => (
        <span className="comment-file uploading" role="listitem" key={`pending-${index}`}>
          <Paperclip size={16} aria-hidden="true" />
          <span className="comment-file-name">{name}</span>
          <small>{t("Wird hochgeladen …", "Uploading …")}</small>
        </span>
      ))}
      {viewer && <ImageViewer image={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

// Compact cards for the first links of a comment (title, site, text, image).
export function CommentPreviews({
  previews,
  onRemove,
}: {
  previews: CommentLinkPreview[];
  onRemove?: (url: string) => void;
}) {
  const t = useT();
  return (
    <div className="comment-link-cards">
      {previews.map((p) => (
        <span className="comment-link-card" key={p.url}>
          <a href={p.url} target="_blank" rel="noopener noreferrer">
            {p.image && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={p.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
            )}
            <span>
              <small>{p.site || hostOf(p.url)}</small>
              <strong>{p.title || p.url}</strong>
              {p.description && <span className="comment-link-card-text">{p.description}</span>}
            </span>
          </a>
          {onRemove && (
            <button
              type="button"
              className="icon-button comment-file-remove"
              aria-label={t(`Linkvorschau entfernen: ${p.title || p.url}`, `Remove link preview: ${p.title || p.url}`)}
              title={t("Vorschau entfernen", "Remove preview")}
              onClick={() => onRemove(p.url)}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
