"use client";
// Rich text, tags and link badges of board elements (lib/whiteboard-
// richtext.ts, lib/whiteboard-tags.ts). Everything renders as React
// elements from parsed spans – no HTML from the board ever reaches the
// page. Links carry data attributes the board reads on pointer down
// (components/whiteboard/board-actions.ts): web links open in a new tab,
// element links fly to the element.
import type { ReactNode } from "react";
import { LinkSimple } from "@phosphor-icons/react";
import { parseRichText, type Span } from "@/lib/whiteboard-richtext";
import { parseElementLink, safeHref } from "@/lib/whiteboard-links";
import { itemTags, tagColor } from "@/lib/whiteboard-tags";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

function SpanView({ span }: { span: Span }) {
  let node: ReactNode = span.text;
  if (span.bold) node = <strong>{node}</strong>;
  if (span.italic) node = <em>{node}</em>;
  if (span.underline) node = <u>{node}</u>;
  if (!span.href) return <>{node}</>;
  const element = parseElementLink(span.href);
  if (element && !element.pageId)
    return (
      <span className="wb-link" role="link" data-wb-item={element.itemId}>
        {node}
      </span>
    );
  return (
    <a className="wb-link" href={span.href} data-wb-href={span.href} target="_blank" rel="noopener noreferrer nofollow">
      {node}
    </a>
  );
}
const spans = (list: Span[], key: string) => list.map((span, i) => <SpanView key={`${key}-${i}`} span={span} />);

export function RichText({ text }: { text: string }) {
  return (
    <div className="wb-rich">
      {parseRichText(text).map((block, i) =>
        block.kind === "p" ? (
          <p key={i}>{block.spans.length ? spans(block.spans, `p${i}`) : <br />}</p>
        ) : block.kind === "ul" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{spans(item, `u${i}-${j}`)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} start={block.start}>
            {block.items.map((item, j) => (
              <li key={j}>{spans(item, `o${i}-${j}`)}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}

// Tags of a note as chips along its bottom edge.
export function TagChips({ item }: { item: WhiteboardItem }) {
  const tags = itemTags(item);
  if (!tags.length) return null;
  return (
    <foreignObject x={6} y={Math.max(0, item.h - 28)} width={Math.max(1, item.w - 12)} height={24}>
      <div className="wb-tags">
        {tags.map((tag) => {
          const [bg, fg] = tagColor(tag);
          return (
            <span key={tag} className="wb-tag" style={{ background: bg, color: fg }}>
              {tag}
            </span>
          );
        })}
      </div>
    </foreignObject>
  );
}

// A link set on the element: a small badge at its top right corner.
export function LinkBadge({ item }: { item: WhiteboardItem }) {
  const href = safeHref(item.link);
  if (!href || item.type === "connector" || item.type === "pen" || item.type === "comment") return null;
  const element = parseElementLink(href);
  const size = 22;
  return (
    <foreignObject x={item.w - size / 2} y={-size / 2} width={size} height={size} className="wb-link-badge-box">
      {element && !element.pageId ? (
        <span className="wb-link-badge" role="link" data-wb-item={element.itemId} title={href}>
          <LinkSimple size={13} weight="bold" />
        </span>
      ) : (
        <a className="wb-link-badge" href={href} data-wb-href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>
          <LinkSimple size={13} weight="bold" />
        </a>
      )}
    </foreignObject>
  );
}
