// A whiteboard as a self-contained SVG, for the Markdown export (#34). It
// draws what components/whiteboard/render.tsx draws, cropped like "Export as
// SVG" in the board (content bounds, 40 px padding), without anything of the
// interface. Texts use foreignObject with inline styles, which browsers,
// Forgejo, GitHub and GitLab show when the file is opened. Covered items stay
// covered; comment pins are left out (they belong to the conversation, not
// the drawing).
import { pressureOutline } from "./whiteboard-tools";
import { safeImageSource, type WhiteboardItem } from "./whiteboard-model";
import { connectorGeometry, contentBounds, shapePath } from "./whiteboard-geometry";
// Diagrams: library shapes, connector ends, timelines.
import { cleanDiagramFields, publicTimeline } from "./whiteboard-diagram-model";
import { connectorEnds, markerSvg } from "./whiteboard-connector-markers";
import { libraryShapeSvg } from "./whiteboard-shapes-library";
import { timelineSvg } from "./whiteboard-timeline";
import { hasRichText, richTextHtml } from "./whiteboard-richtext";
import { boardEmbed, withValidExtras } from "./whiteboard-embeds";
import { itemTags, tagColor } from "./whiteboard-tags";

export type WhiteboardSvgContext = {
  // A file or image source as used in the export (relative path, https URL),
  // or null to leave the image out.
  image: (src: string) => string | null;
  page: (pageId: string) => { title: string; kind: string } | null;
  record: (pageId: string, rowId: string) => { title: string; database: string } | null;
  label: (de: string, en: string) => string;
};

const PAD = 40;
const attr = (value: string | number) =>
  String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const text = (value: string) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Only plain colours from the board's palette reach an attribute.
const color = (value: string | undefined, fallback: string) =>
  value && /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d.,\s%]+\))$/i.test(value) ? value : fallback;
const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const STYLE =
  ".wb-text{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;white-space:pre-wrap;word-break:break-word;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;box-sizing:border-box}" +
  ".wb-frame-title{font:600 14px system-ui,sans-serif;color:#495057;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
  ".wb-card-body{display:flex;flex-direction:column;justify-content:center;height:100%;font:14px system-ui,sans-serif;color:#1f2937;overflow:hidden}" +
  ".wb-card-body small{color:#868e96;font-size:12px}" +
  ".wb-connector-label{display:flex;align-items:center;justify-content:center;height:100%;font:13px system-ui,sans-serif;color:#1f2937}.wb-connector-label span{background:#fff;padding:0 4px;border-radius:4px}" +
  ".wb-table-grid{display:grid;width:100%;height:100%;font-family:system-ui,sans-serif;color:#1f2937}" +
  ".wb-cell{border:1px solid #dee2e6;padding:4px 6px;overflow:hidden;white-space:pre-wrap}.wb-cell.head{font-weight:600;background:#f1f3f5}" +
  ".wb-emoji-glyph{display:flex;align-items:center;justify-content:center;height:100%}";

function html(width: number, height: number, inner: string, x = 0, y = 0) {
  return `<foreignObject x="${x}" y="${y}" width="${Math.max(1, width)}" height="${Math.max(1, height)}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%">${inner}</div></foreignObject>`;
}
const ALIGN = new Set(["left", "center", "right", "justify"]);
function textBox(item: WhiteboardItem, padding = 10, align?: string) {
  const style = [
    `padding:${padding}px`,
    `font-size:${num(item.fontSize, 16)}px`,
    `font-weight:${item.bold ? 700 : 400}`,
    `text-align:${[align, item.align].find((a) => a && ALIGN.has(a)) || "center"}`,
    `color:${color(item.textColor, "#1f2937")}`,
    `justify-content:${item.type === "text" ? "flex-start" : "center"}`,
    ...(item.italic ? ["font-style:italic"] : []),
    ...(item.underline ? ["text-decoration:underline"] : []),
  ].join(";");
  const body = hasRichText(item.text) ? `<div style="white-space:normal">${richTextHtml(item.text || "")}</div>` : text(item.text || "");
  return html(item.w, item.h, `<div class="wb-text" style="${attr(style)}">${body}</div>`);
}
// Tags of a note as chips along its bottom edge.
function tagChips(item: WhiteboardItem) {
  const tags = itemTags(item);
  if (!tags.length) return "";
  const chips = tags
    .map((tag) => {
      const [bg, fg] = tagColor(tag);
      return `<span style="background:${bg};color:${fg};border-radius:9px;padding:1px 7px;font:600 11px system-ui,sans-serif;white-space:nowrap">${text(tag)}</span>`;
    })
    .join("");
  return html(item.w - 12, 24, `<div style="display:flex;gap:4px;overflow:hidden">${chips}</div>`, 6, item.h - 28);
}

// Planning poker: the value taken over, as in render.tsx.
function estimateTag(item: WhiteboardItem) {
  if (!item.estimate) return "";
  const value = String(item.estimate).slice(0, 12),
    w = 14 + value.length * 9;
  return `<g transform="translate(${item.w - w - 6} 6)"><rect width="${w}" height="22" rx="11" fill="#1f2937"/><text x="${w / 2}" y="15.5" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="#ffffff">${text(value)}</text></g>`;
}
function shape(item: WhiteboardItem, items: Map<string, WhiteboardItem>, ctx: WhiteboardSvgContext): string {
  const transform = `translate(${item.x} ${item.y})${item.rotation ? ` rotate(${num(item.rotation)} ${item.w / 2} ${item.h / 2})` : ""}`;
  const g = (inner: string) => `<g transform="${transform}">${inner}</g>`;
  if (item.covered && !["frame", "connector", "comment"].includes(item.type))
    return g(
      `<rect width="${item.w}" height="${item.h}" rx="10" fill="url(#wb-cover-hatch)"/><text x="${item.w / 2}" y="${item.h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="${Math.max(12, Math.min(22, Math.min(item.w, item.h) / 6))}" fill="#ffffff">${text(ctx.label("Verdeckt", "Hidden"))}</text>`,
    );
  switch (item.type) {
    case "sticky":
      return g(`<rect width="${item.w}" height="${item.h}" rx="4" fill="${attr(color(item.fill, "#fff6b6"))}" filter="url(#wb-shadow)"/>${textBox(item)}${tagChips(item)}${estimateTag(item)}`);
    case "text":
      return g(textBox(item, 2, item.align && ALIGN.has(item.align) ? item.align : "left"));
    case "shape": {
      const drawn = libraryShapeSvg(item);
      if (drawn) return g(drawn);
      return g(
        `<path d="${shapePath(item.shape, item.w, item.h)}" fill="${attr(color(item.fill, "#ffffff"))}" stroke="${attr(color(item.stroke, "#1f2937"))}" stroke-width="${num(item.strokeWidth, 2)}"${item.dashed ? ' stroke-dasharray="8 6"' : ""}/>${textBox(item)}`,
      );
    }
    case "timeline":
      return item.timeline ? g(timelineSvg(item, publicTimeline(item.timeline)!, { today: new Date().toISOString().slice(0, 10), weekLabel: ctx.label("KW", "W") })) : "";
    case "frame":
      return `<g transform="translate(${item.x} ${item.y})"><rect width="${item.w}" height="${item.h}" fill="${attr(item.fill && item.fill !== "transparent" ? color(item.fill, "#ffffff") : "#ffffff")}" stroke="#ced4da" stroke-width="1" rx="6"/>${html(item.w, 26, `<div class="wb-frame-title">${text(item.text || ctx.label("Rahmen", "Frame"))}</div>`, 0, -28)}</g>`;
    case "pen": {
      const pts = item.points || [];
      const stroke = attr(color(item.stroke, "#1f2937"));
      if (item.pressures?.length && item.pressures.length * 2 === pts.length) {
        const points = item.pressures.map((p, i) => ({ x: item.x + pts[i * 2] * item.w, y: item.y + pts[i * 2 + 1] * item.h, p }));
        return `<path d="${pressureOutline(points, num(item.strokeWidth, 3) * 1.6)}" fill="${stroke}" stroke="none"/>`;
      }
      let d = "";
      for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? " L" : "M"} ${item.x + pts[i] * item.w} ${item.y + pts[i + 1] * item.h}`;
      return d ? `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${num(item.strokeWidth, 3)}" stroke-linecap="round" stroke-linejoin="round"/>` : "";
    }
    case "connector": {
      const { a, b, d, endDir, startDir } = connectorGeometry(item, items);
      const stroke = color(item.stroke, "#1f2937"),
        width = num(item.strokeWidth, 2);
      return `<g><path d="${d}" fill="none" stroke="${attr(stroke)}" stroke-width="${width}"${item.dashed ? ' stroke-dasharray="8 6"' : ""} stroke-linecap="round"/>${
        markerSvg(connectorEnds(item).end, b, endDir, width, stroke) + markerSvg(connectorEnds(item).start, a, startDir, width, stroke)
      }${
        item.text ? html(160, 28, `<div class="wb-connector-label"><span>${text(item.text)}</span></div>`, (a.x + b.x) / 2 - 80, (a.y + b.y) / 2 - 14) : ""
      }</g>`;
    }
    case "image": {
      const href = safeImageSource(item.src) ? ctx.image(item.src!) : null;
      // Cropped pictures: the whole picture, moved and clipped to the part.
      const crop = item.crop;
      const full = crop ? { w: item.w / crop.w, h: item.h / crop.h } : null;
      return g(
        (item.credit ? `<title>${text(item.credit)}</title>` : "") +
          (href && crop && full
            ? `<svg width="${item.w}" height="${item.h}" overflow="hidden"><image href="${attr(href)}" x="${-crop.x * full.w}" y="${-crop.y * full.h}" width="${full.w}" height="${full.h}" preserveAspectRatio="none"/></svg>`
            : href
              ? `<image href="${attr(href)}" width="${item.w}" height="${item.h}" preserveAspectRatio="xMidYMid meet"/>`
              : `<rect width="${item.w}" height="${item.h}" fill="#f1f3f5"/>`),
      );
    }
    case "embed": {
      // The export never loads players: a card with the provider and link.
      const embed = boardEmbed(item);
      if (!embed) return "";
      const link = embed.kind === "player" ? item.url || embed.src : "";
      const title = item.text || (embed.kind === "pdf" ? "PDF" : embed.provider);
      return g(
        `<rect width="${item.w}" height="${item.h}" rx="10" fill="#1f2937"/>` +
          html(
            item.w,
            item.h,
            `<div class="wb-card-body" style="align-items:center;text-align:center;color:#ffffff;padding:12px;box-sizing:border-box"><small style="color:#ced4da">${text(
              embed.kind === "pdf" ? ctx.label("PDF-Dokument", "PDF document") : embed.provider,
            )}</small><strong>${text(title)}</strong>${link ? `<a href="${attr(link)}" style="color:#a5d8ff;font-size:12px;word-break:break-all">${text(link)}</a>` : ""}</div>`,
          ),
      );
    }
    case "card": {
      const page = item.pageId ? ctx.page(item.pageId) : null;
      const card = (accent: string, small: string, strong: string) =>
        g(
          `<rect width="${item.w}" height="${item.h}" rx="10" fill="#ffffff" stroke="#dee2e6" filter="url(#wb-shadow)"/><rect width="6" height="${item.h}" rx="3" fill="${attr(color(item.fill, accent))}"/>` +
            html(item.w - 20, item.h, `<div class="wb-card-body"><small>${text(small)}</small><strong>${text(strong)}</strong></div>`, 14, 0),
        );
      if (item.rowId) {
        const record = item.pageId ? ctx.record(item.pageId, item.rowId) : null;
        return card("#e0782c", record?.database || page?.title || ctx.label("Datenbank", "Database"), record?.title ?? ctx.label("Eintrag nicht verfügbar", "Record not available"));
      }
      return card(
        "#3b3fd8",
        page?.kind === "database" ? ctx.label("Datenbank", "Database") : page?.kind === "whiteboard" ? "Whiteboard" : ctx.label("Seite", "Page"),
        page?.title || ctx.label("Seite nicht verfügbar", "Page not available"),
      );
    }
    case "table": {
      const cells = item.cells?.length ? item.cells : [[""]];
      const cols = Math.max(1, ...cells.map((r) => r.length));
      const grid = cells
        .flatMap((row, r) => Array.from({ length: cols }, (_, c) => `<div class="wb-cell${r === 0 && item.header !== false ? " head" : ""}">${text(row[c] || "")}</div>`))
        .join("");
      return g(
        `<rect width="${item.w}" height="${item.h}" fill="#ffffff" stroke="#adb5bd" rx="4"/>` +
          html(item.w, item.h, `<div class="wb-table-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:repeat(${cells.length},minmax(0,1fr));font-size:${num(item.fontSize, 14)}px">${grid}</div>`),
      );
    }
    case "emoji":
      // Library icons are drawn by the interface; the export shows a marker.
      if (item.emoji?.startsWith("icon:"))
        return g(`<circle cx="${item.w / 2}" cy="${item.h / 2}" r="${Math.min(item.w, item.h) * 0.4}" fill="none" stroke="${attr(color(item.stroke, "#1f2937"))}" stroke-width="2"/>`);
      return g(html(item.w, item.h, `<div class="wb-emoji-glyph" style="font-size:${Math.min(item.w, item.h) * 0.8}px">${text(item.emoji || "")}</div>`));
    default:
      return "";
  }
}

// Board data comes from clients: every number that ends up in an attribute
// is a finite number, every list a list of them.
const end = (e: WhiteboardItem["from"]) => (e ? { ...e, x: num(e.x), y: num(e.y) } : e);
function clean(raw: WhiteboardItem): WhiteboardItem {
  const item = withValidExtras(raw);
  return cleanDiagramFields({
    ...item,
    x: num(item.x),
    y: num(item.y),
    w: Math.max(0, num(item.w)),
    h: Math.max(0, num(item.h)),
    rotation: num(item.rotation),
    fontSize: item.fontSize === undefined ? undefined : num(item.fontSize, 16),
    strokeWidth: item.strokeWidth === undefined ? undefined : num(item.strokeWidth, 2),
    points: Array.isArray(item.points) ? item.points.map((v) => num(v)) : undefined,
    pressures: Array.isArray(item.pressures) ? item.pressures.map((v) => num(v, 0.5)) : undefined,
    cells: Array.isArray(item.cells) ? item.cells.map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? "")) : [])) : undefined,
    from: end(item.from),
    to: end(item.to),
    text: item.text === undefined ? undefined : String(item.text),
  });
}

// The SVG, or null for a board without anything to show.
export function whiteboardSvg(raw: WhiteboardItem[], ctx: WhiteboardSvgContext, title = "") {
  const all = raw.map(clean);
  const items = all.filter((item) => item.type !== "comment");
  const map = new Map(all.map((item) => [item.id, item]));
  const box = contentBounds(items, map);
  if (!box) return null;
  const x = box.x - PAD,
    y = box.y - PAD,
    w = box.w + PAD * 2,
    h = box.h + PAD * 2;
  const frames = items.filter((i) => i.type === "frame"),
    others = items.filter((i) => i.type !== "frame");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}" role="img"${title ? ` aria-label="${attr(title)}"` : ""}>\n` +
    (title ? `<title>${text(title)}</title>\n` : "") +
    `<style>${STYLE}</style>\n` +
    `<defs><filter id="wb-shadow" x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-opacity="0.16"/></filter>` +
    `<pattern id="wb-cover-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" fill="#3b3fd8"/><rect width="4" height="10" fill="#4a4ee6"/></pattern></defs>\n` +
    // A white sheet, so the drawing stays readable in dark viewers.
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>\n` +
    [...frames, ...others].map((item) => shape(item, map, ctx)).filter(Boolean).join("\n") +
    "\n</svg>\n"
  );
}
