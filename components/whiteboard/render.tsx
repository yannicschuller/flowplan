"use client";
import { useT } from "../i18n";
import { pressureOutline } from "@/lib/whiteboard-tools";
import { LibraryIcon } from "../library-icons";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { placeholderKey, usePlaceholder } from "../image-placeholder";
import { safeImageSource, type WhiteboardItem } from "@/lib/whiteboard-model";
import { connectorGeometry, contentBounds, shapePath } from "@/lib/whiteboard-geometry";
import { displayText } from "@/lib/field-format";
import type { RowCardData, RowCardProp } from "@/lib/whiteboard-cards";
import { connectorEnds, markerSvg } from "@/lib/whiteboard-connector-markers";
import { isLibraryShape } from "@/lib/whiteboard-shapes-library";
import { LibraryShapeView } from "./library-shape";
import { TimelineItemView } from "./timeline-item";
import { hasRichText } from "@/lib/whiteboard-richtext";
import { cleanCrop } from "@/lib/whiteboard-embeds";
import { LinkBadge, RichText, TagChips } from "./rich-text";
import { EmbedShape } from "./embed-item";
import { CardExcerpt } from "./card-preview";

export type PageRef = {
  id: string;
  title: string;
  icon?: string;
  kind?: string;
};

// Geometry lives in lib/whiteboard-geometry.ts so the server can draw boards
// too (SVG in the Markdown export).
export { shapePath, connectorGeometry, contentBounds } from "@/lib/whiteboard-geometry";
function TextBox({
  item,
  padding = 10,
  style,
  children,
}: {
  item: WhiteboardItem;
  padding?: number;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <foreignObject
      x={0}
      y={0}
      width={Math.max(1, item.w)}
      height={Math.max(1, item.h)}
    >
      <div
        className="wb-text"
        style={{
          padding,
          fontSize: item.fontSize || 16,
          fontWeight: item.bold ? 700 : 400,
          textAlign: item.align || "center",
          color: item.textColor || "#1f2937",
          justifyContent: item.type === "text" ? "flex-start" : "center",
          fontStyle: item.italic ? "italic" : undefined,
          textDecoration: item.underline ? "underline" : undefined,
          ...style,
        }}
      >
        {children ?? (hasRichText(item.text) ? <RichText text={item.text || ""} /> : item.text)}
      </div>
    </foreignObject>
  );
}
// A covered item shows only its outline: nothing of its content is in the
// DOM until it is uncovered.
function CoveredShape({
  item,
  transform,
}: {
  item: WhiteboardItem;
  transform: string;
}) {
  const t = useT();
  const size = Math.max(12, Math.min(22, Math.min(item.w, item.h) / 6));
  return (
    <g transform={transform} className="wb-covered">
      <rect
        width={item.w}
        height={item.h}
        rx={10}
        fill="url(#wb-cover-hatch)"
        className="wb-cover-card"
      />
      <text
        x={item.w / 2}
        y={item.h / 2}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={size}
        className="wb-cover-label"
      >
        {t("Verdeckt", "Hidden")}
      </text>
    </g>
  );
}
export type RowCard = RowCardData;
// A property on a record card: dates and numbers formatted here, in the
// person's language and time zone, like the database views do.
function rowCardValue(prop: RowCardProp) {
  if (prop.raw === undefined || !prop.format) return prop.value;
  return displayText(prop.format, prop.raw).slice(0, 60) || prop.value;
}
function ShapeBody({
  item,
  items,
  pages,
  editing,
  cards,
}: {
  item: WhiteboardItem;
  items: Map<string, WhiteboardItem>;
  pages: PageRef[];
  editing?: ReactNode;
  // Live data of database records shown as cards.
  cards?: Map<string, RowCard>;
}) {
  const t = useT();
  const transform = `translate(${item.x} ${item.y})${item.rotation ? ` rotate(${item.rotation} ${item.w / 2} ${item.h / 2})` : ""}`;
  const text = editing ?? undefined;
  if (item.covered && !["frame", "connector", "comment"].includes(item.type))
    return <CoveredShape item={item} transform={transform} />;
  switch (item.type) {
    case "sticky":
      return (
        <g transform={transform}>
          <rect
            width={item.w}
            height={item.h}
            rx={4}
            fill={item.fill || "#fff6b6"}
            filter="url(#wb-shadow)"
          />
          <TextBox item={item}>{text}</TextBox>
        </g>
      );
    case "text":
      return (
        <g transform={transform}>
          <rect width={item.w} height={item.h} fill="transparent" />
          <TextBox
            item={item}
            padding={2}
            style={{ textAlign: item.align || "left" }}
          >
            {text}
          </TextBox>
        </g>
      );
    case "shape":
      if (isLibraryShape(item.lib)) return <LibraryShapeView item={item} transform={transform} hideText={editing !== undefined} />;
      return (
        <g transform={transform}>
          <path
            d={shapePath(item.shape, item.w, item.h)}
            fill={item.fill || "#ffffff"}
            stroke={item.stroke || "#1f2937"}
            strokeWidth={item.strokeWidth ?? 2}
            strokeDasharray={item.dashed ? "8 6" : undefined}
            vectorEffect="non-scaling-stroke"
          />
          <TextBox item={item}>{text}</TextBox>
        </g>
      );
    case "frame":
      return (
        <g transform={`translate(${item.x} ${item.y})`}>
          <rect
            width={item.w}
            height={item.h}
            fill={
              item.fill && item.fill !== "transparent" ? item.fill : "#ffffff"
            }
            stroke="#ced4da"
            strokeWidth={1}
            rx={6}
          />
          <foreignObject x={0} y={-28} width={Math.max(1, item.w)} height={26}>
            <div className="wb-frame-title">
              {text ?? (item.text || t("Rahmen", "Frame"))}
            </div>
          </foreignObject>
        </g>
      );
    case "pen": {
      const pts = item.points || [];
      // Stylus strokes: a filled outline whose width follows the pressure.
      if (item.pressures?.length && item.pressures.length * 2 === pts.length) {
        const points = item.pressures.map((pressure, i) => ({
          x: item.x + pts[i * 2] * item.w,
          y: item.y + pts[i * 2 + 1] * item.h,
          p: pressure,
        }));
        return (
          <path
            d={pressureOutline(points, (item.strokeWidth ?? 3) * 1.6)}
            fill={item.stroke || "#1f2937"}
            stroke="none"
          />
        );
      }
      let d = "";
      for (let i = 0; i + 1 < pts.length; i += 2)
        d += `${i ? " L" : "M"} ${item.x + pts[i] * item.w} ${item.y + pts[i + 1] * item.h}`;
      return (
        <path
          d={d}
          fill="none"
          stroke={item.stroke || "#1f2937"}
          strokeWidth={item.strokeWidth ?? 3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    case "connector": {
      const { a, b, d, endDir, startDir } = connectorGeometry(item, items);
      const color = item.stroke || "#1f2937",
        width = item.strokeWidth ?? 2;
      return (
        <g>
          <path
            d={d}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(12, width + 10)}
          />
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeDasharray={item.dashed ? "8 6" : undefined}
            strokeLinecap="round"
          />
          {/* Arrowheads, UML and crow's-foot ends (lib/whiteboard-connector-markers.ts). */}
          <g
            dangerouslySetInnerHTML={{
              __html: markerSvg(connectorEnds(item).end, b, endDir, width, color) + markerSvg(connectorEnds(item).start, a, startDir, width, color),
            }}
          />
          {item.text && (
            <foreignObject
              x={(a.x + b.x) / 2 - 80}
              y={(a.y + b.y) / 2 - 14}
              width={160}
              height={28}
            >
              <div className="wb-connector-label">{item.text}</div>
            </foreignObject>
          )}
        </g>
      );
    }
    case "image":
      return (
        <g transform={transform}>
          {item.credit && <title>{item.credit}</title>}
          {safeImageSource(item.src) && cleanCrop(item.crop) ? (
            <CroppedImage src={item.src!} w={item.w} h={item.h} crop={cleanCrop(item.crop)!} />
          ) : safeImageSource(item.src) ? (
            <BoardImage src={item.src!} w={item.w} h={item.h} />
          ) : (
            <rect width={item.w} height={item.h} fill="#f1f3f5" />
          )}
        </g>
      );
    case "card": {
      const page = pages.find((p) => p.id === item.pageId);
      const row = item.rowId ? cards?.get(item.rowId) : undefined;
      if (item.rowId)
        return (
          <g transform={transform}>
            <rect width={item.w} height={item.h} rx={10} fill="#ffffff" stroke="#dee2e6" filter="url(#wb-shadow)" />
            <rect width={6} height={item.h} rx={3} fill={item.fill || "#e0782c"} />
            <foreignObject x={14} y={0} width={Math.max(1, item.w - 20)} height={item.h}>
              <div className="wb-card-body wb-row-card">
                <small>{row?.database || page?.title || t("Datenbank", "Database")}</small>
                <strong>{row ? row.title || t("Ohne Titel", "Untitled") : t("Eintrag nicht verfügbar", "Record not available")}</strong>
                {!!row?.props.length && (
                  <span className="wb-row-props">
                    {row.props.map((p) => (
                      <span key={p.name} title={p.name}>
                        {rowCardValue(p)}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </foreignObject>
          </g>
        );
      return (
        <g transform={transform}>
          <rect
            width={item.w}
            height={item.h}
            rx={10}
            fill="#ffffff"
            stroke="#dee2e6"
            filter="url(#wb-shadow)"
          />
          <rect
            width={6}
            height={item.h}
            rx={3}
            fill={item.fill || "#3b3fd8"}
          />
          <foreignObject
            x={14}
            y={0}
            width={Math.max(1, item.w - 20)}
            height={item.h}
          >
            <div className="wb-card-body">
              <small>
                {page?.kind === "database"
                  ? t("Datenbank", "Database")
                  : page?.kind === "whiteboard"
                    ? t("Whiteboard", "Whiteboard")
                    : t("Seite", "Page")}
              </small>
              <strong>{page?.title || t("Seite nicht verfügbar", "Page not available")}</strong>
              {page?.kind === "document" && item.h >= 130 && <CardExcerpt pageId={page.id} />}
            </div>
          </foreignObject>
        </g>
      );
    }
    case "comment": {
      const count = item.messages?.length || 0;
      return (
        <g
          transform={`translate(${item.x} ${item.y})`}
          opacity={item.resolved ? 0.45 : 1}
        >
          <path
            d="M 16 0 C 25 0 32 7 32 16 C 32 25 25 32 16 32 L 2 32 L 2 16 C 2 7 7 0 16 0 Z"
            fill={item.resolved ? "#adb5bd" : "#f08c00"}
            stroke="#ffffff"
            strokeWidth={2}
            filter="url(#wb-shadow)"
          />
          <text
            x={17}
            y={21}
            textAnchor="middle"
            fontSize={13}
            fontWeight={700}
            fill="#ffffff"
          >
            {count || "+"}
          </text>
        </g>
      );
    }
    case "table": {
      const cells = item.cells?.length ? item.cells : [[""]];
      const cols = Math.max(1, ...cells.map((r) => r.length));
      return (
        <g transform={transform}>
          <rect
            width={item.w}
            height={item.h}
            fill="#ffffff"
            stroke="#adb5bd"
            rx={4}
          />
          <foreignObject
            width={Math.max(1, item.w)}
            height={Math.max(1, item.h)}
          >
            <div
              className="wb-table-grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${cells.length}, minmax(0, 1fr))`,
                fontSize: item.fontSize || 14,
              }}
            >
              {cells.flatMap((row, r) =>
                Array.from({ length: cols }, (_, c) => (
                  <div
                    key={`${r}:${c}`}
                    className={`wb-cell${r === 0 && item.header !== false ? " head" : ""}`}
                    data-cell={`${r}:${c}`}
                  >
                    {row[c] || ""}
                  </div>
                )),
              )}
            </div>
          </foreignObject>
        </g>
      );
    }
    case "timeline":
      return <TimelineItemView item={item} transform={transform} />;
    case "embed":
      return <EmbedShape item={item} transform={transform} interactive={!!cards} />;
    case "emoji":
      return (
        <g transform={transform}>
          <foreignObject
            width={Math.max(1, item.w)}
            height={Math.max(1, item.h)}
          >
            {item.emoji?.startsWith("icon:") ? (
              <div className="wb-emoji-glyph wb-icon-glyph" style={{ color: item.stroke || "#1f2937" }}>
                <LibraryIcon value={item.emoji} size={Math.min(item.w, item.h) * 0.9} />
              </div>
            ) : (
              <div
                className="wb-emoji-glyph"
                style={{ fontSize: Math.min(item.w, item.h) * 0.8 }}
              >
                {item.emoji}
              </div>
            )}
          </foreignObject>
        </g>
      );
  }
}
// An element with what every kind can carry: tags on notes, a link badge.
export function WhiteboardShape(props: Parameters<typeof ShapeBody>[0]) {
  const { item } = props;
  const decorated = !item.covered && (item.link || (item.type === "sticky" && item.tags?.length));
  if (!decorated) return <ShapeBody {...props} />;
  const transform = `translate(${item.x} ${item.y})${item.rotation ? ` rotate(${item.rotation} ${item.w / 2} ${item.h / 2})` : ""}`;
  return (
    <>
      <ShapeBody {...props} />
      <g transform={transform}>
        {item.type === "sticky" && <TagChips item={item} />}
        <LinkBadge item={item} />
      </g>
    </>
  );
}
// A cropped picture: the whole picture moved and clipped to the part.
function CroppedImage({ src, w, h, crop }: { src: string; w: number; h: number; crop: { x: number; y: number; w: number; h: number } }) {
  const fw = w / crop.w,
    fh = h / crop.h;
  return (
    <svg width={Math.max(1, w)} height={Math.max(1, h)} overflow="hidden">
      <g transform={`translate(${-crop.x * fw} ${-crop.y * fh})`}>
        <BoardImage src={src} w={fw} h={fh} />
      </g>
    </svg>
  );
}
// Shared definitions (shadow) for every rendering of a board.
export function WhiteboardDefs() {
  return (
    <defs>
      <filter id="wb-shadow" x="-10%" y="-10%" width="130%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodOpacity="0.16" />
      </filter>
      <pattern
        id="wb-grid"
        width="24"
        height="24"
        patternUnits="userSpaceOnUse"
      >
        <circle cx="1" cy="1" r="1" fill="#ced4da" />
      </pattern>
      <pattern
        id="wb-cover-hatch"
        width="10"
        height="10"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="10" height="10" fill="#3b3fd8" />
        <rect width="4" height="10" fill="#4a4ee6" />
      </pattern>
    </defs>
  );
}
// Static board, e.g. embedded in a document.
export function WhiteboardStatic({
  items,
  pages,
  height = 320,
}: {
  items: WhiteboardItem[];
  pages: PageRef[];
  height?: number;
}) {
  const t = useT();
  const map = new Map(items.map((i) => [i.id, i]));
  const box = contentBounds(items, map);
  const pad = 40;
  const view = box
    ? `${box.x - pad} ${box.y - pad} ${box.w + pad * 2} ${box.h + pad * 2}`
    : "0 0 800 400";
  return (
    <svg
      className="wb-static"
      viewBox={view}
      style={{ height }}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={t("Whiteboard-Vorschau", "Whiteboard preview")}
    >
      <WhiteboardDefs />
      {items
        .filter((i) => i.type === "frame")
        .map((item) => (
          <g key={item.id} className={`wb-${item.type}`}>
            <WhiteboardShape item={item} items={map} pages={pages} />
          </g>
        ))}
      {items
        .filter((i) => i.type !== "frame")
        .map((item) => (
          <g key={item.id} className={`wb-${item.type}`}>
            <WhiteboardShape item={item} items={map} pages={pages} />
          </g>
        ))}
    </svg>
  );
}

// An uploaded image on the board: its blurred placeholder in the same box
// until the image has faded in (components/image-placeholder.ts). Images
// from the browser's cache appear at once.
function BoardImage({ src, w, h }: { src: string; w: number; h: number }) {
  const entry = usePlaceholder(src);
  const [state, setState] = useState<{ src: string; phase: "loaded" | "instant" | "settled" } | null>(null);
  const mounted = useRef(0);
  useEffect(() => {
    mounted.current = performance.now();
  }, [src]);
  useEffect(() => {
    if (state?.src !== src || state.phase !== "loaded") return;
    const timer = setTimeout(() => setState({ src, phase: "settled" }), 340);
    return () => clearTimeout(timer);
  }, [state, src]);
  const phase = state?.src === src ? state.phase : null;
  const fades = !!placeholderKey(src);
  return (
    <>
      {entry?.url && (!phase || phase === "loaded") && (
        <image href={entry.url} width={w} height={h} preserveAspectRatio="xMidYMid meet" aria-hidden="true" />
      )}
      <image
        href={src}
        width={w}
        height={h}
        preserveAspectRatio="xMidYMid meet"
        className={fades ? `fp-fade${phase ? " is-loaded" : ""}${phase === "instant" ? " fp-instant" : ""}` : undefined}
        onLoad={() => setState({ src, phase: performance.now() - mounted.current < 60 ? "instant" : "loaded" })}
        onError={() => setState({ src, phase: "settled" })}
      />
    </>
  );
}
