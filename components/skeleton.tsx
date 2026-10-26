"use client";
// Placeholders in the shape of what is loading: a table, a board, a calendar,
// a gallery, a list, a record, the inbox, search hits, a start page widget,
// a settings section. They shimmer softly (still with reduced motion, and in
// the dark theme on its own colors – app/globals.css, .sk) and tell screen
// readers once that something is loading.
import type { CSSProperties } from "react";
import { useT } from "./i18n";

export type ViewShape = "table" | "board" | "calendar" | "gallery" | "list" | "timeline" | "chart" | "feed" | "form" | "sprint";

const bar = (width: string | number, height?: number, style: CSSProperties = {}) => (
  <span className="sk" style={{ width, ...(height ? { height } : {}), ...style }} />
);

// The body of a database view while its data loads (no label, aria-hidden).
export function ViewShapeBody({ type = "table" }: { type?: ViewShape }) {
  switch (type) {
    case "board":
    case "sprint":
      return (
        <div className="sk-board">
          {[3, 2, 4, 1].map((cards, column) => (
            <div className="sk-board-column" key={column}>
              {bar("55%", 16)}
              {Array.from({ length: cards }, (_, i) => (
                <span key={i} className="sk sk-card" />
              ))}
            </div>
          ))}
        </div>
      );
    case "calendar":
      return (
        <div className="sk-calendar">
          {Array.from({ length: 35 }, (_, i) => (
            <span key={i} className="sk-day">
              {i % 5 === 2 && bar("80%", 10)}
            </span>
          ))}
        </div>
      );
    case "gallery":
      return (
        <div className="sk-gallery">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="sk-gallery-card" key={i}>
              <span className="sk sk-cover" />
              {bar("70%", 12)}
              {bar("45%", 10)}
            </div>
          ))}
        </div>
      );
    case "list":
    case "feed":
      return <LinesBody rows={7} avatar />;
    case "timeline":
      return (
        <div className="sk-timeline">
          {[[0, 40], [15, 30], [30, 45], [10, 25], [45, 35], [25, 50]].map(([left, width], i) => (
            <div className="sk-timeline-row" key={i}>
              {bar("80%", 12)}
              <span className="sk-timeline-track">{bar(`${width}%`, 18, { marginLeft: `${left}%` })}</span>
            </div>
          ))}
        </div>
      );
    case "chart":
      return (
        <div className="sk-chart">
          {[60, 85, 40, 70, 95, 55, 75].map((h, i) => (
            <span key={i} className="sk" style={{ height: `${h}%` }} />
          ))}
        </div>
      );
    case "form":
      return (
        <div className="sk-form">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="sk-form-field">
              {bar("30%", 12)}
              {bar("100%", 34)}
            </div>
          ))}
        </div>
      );
    default:
      return (
        <div className="sk-table">
          {Array.from({ length: 7 }, (_, i) => (
            <div className="sk-row" key={i}>
              <span className="sk" />
              <span className="sk" />
              <span className="sk" />
            </div>
          ))}
        </div>
      );
  }
}

function LinesBody({ rows, avatar = false, meta = true }: { rows: number; avatar?: boolean; meta?: boolean }) {
  return (
    <div className="sk-lines">
      {Array.from({ length: rows }, (_, i) => (
        <div className="sk-line-item" key={i}>
          {avatar && <span className="sk sk-avatar" />}
          <span className="sk-line-text">
            {bar(`${[78, 62, 88, 54, 70, 66, 82, 58][i % 8]}%`, 13)}
            {meta && bar(`${[34, 42, 28, 38][i % 4]}%`, 10)}
          </span>
        </div>
      ))}
    </div>
  );
}

// A labelled placeholder: one polite announcement, the shape is hidden.
function Frame({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`skeleton ${className}`} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

// A database view that is switched to or loads (also inside linked views).
export function ViewSkeleton({ type }: { type?: ViewShape }) {
  const t = useT();
  return (
    <Frame label={t("Ansicht wird geladen …", "Loading view …")} className="skeleton-view">
      <ViewShapeBody type={type} />
    </Frame>
  );
}

// Inbox items, search hits, tasks: rows with a line of detail.
export function ListSkeleton({ rows = 5, avatar = false, label }: { rows?: number; avatar?: boolean; label?: string }) {
  const t = useT();
  return (
    <Frame label={label ?? t("Wird geladen …", "Loading …")} className="skeleton-list">
      <LinesBody rows={rows} avatar={avatar} />
    </Frame>
  );
}

// The record dialog: properties, the text below (only the text while the
// record's document loads – its properties are already there).
export function RecordSkeleton({ properties = true }: { properties?: boolean }) {
  const t = useT();
  return (
    <Frame label={properties ? t("Eintrag wird geladen …", "Loading record …") : t("Dokument wird geladen …", "Loading document …")} className="skeleton-record">
      {properties && <div className="sk-properties">
        {[0, 1, 2, 3].map((i) => (
          <div className="sk-property" key={i}>
            {bar("80%", 12)}
            {bar(`${[60, 40, 75, 50][i]}%`, 14)}
          </div>
        ))}
      </div>}
      <div className="sk-document">
        {[92, 100, 76, 0, 84, 60].map((w, i) => (w ? <span key={i} className="sk sk-line" style={{ width: `${w}%` }} /> : <span key={i} className="sk-gap" />))}
      </div>
    </Frame>
  );
}

// A start page widget.
export function WidgetSkeleton({ rows = 3 }: { rows?: number }) {
  const t = useT();
  return (
    <Frame label={t("Wird geladen …", "Loading …")} className="skeleton-widget">
      <LinesBody rows={rows} meta={false} />
    </Frame>
  );
}

// A settings or administration section: heading, groups of fields.
export function SettingsSkeleton() {
  const t = useT();
  return (
    <Frame label={t("Wird geladen …", "Loading …")} className="skeleton-settings">
      {bar("40%", 20)}
      {bar("70%", 12)}
      {[0, 1].map((group) => (
        <div className="sk-setting-group" key={group}>
          {[0, 1, 2].map((i) => (
            <div className="sk-setting" key={i}>
              <span className="sk-line-text">
                {bar(`${[45, 60, 35][i]}%`, 13)}
                {bar(`${[70, 50, 65][i]}%`, 10)}
              </span>
              {bar(44, 24)}
            </div>
          ))}
        </div>
      ))}
    </Frame>
  );
}

// The view a database showed last in this tab, so its placeholder has that
// shape the next time it opens (only the view type, no content).
const SHAPE_KEY = "flowplan:view-shape";
let shapes: Record<string, ViewShape> | null = null;
function readShapes() {
  if (shapes) return shapes;
  try {
    shapes = JSON.parse(sessionStorage.getItem(SHAPE_KEY) || "{}") || {};
  } catch {
    shapes = {};
  }
  return shapes!;
}
export function rememberViewShape(pageId: string, type: ViewShape) {
  const all = readShapes();
  if (all[pageId] === type) return;
  all[pageId] = type;
  const keys = Object.keys(all);
  if (keys.length > 200) delete all[keys[0]];
  try {
    sessionStorage.setItem(SHAPE_KEY, JSON.stringify(all));
  } catch {}
}
export const viewShapeOf = (pageId: string | null | undefined): ViewShape | undefined =>
  pageId && typeof window !== "undefined" ? readShapes()[pageId] : undefined;
