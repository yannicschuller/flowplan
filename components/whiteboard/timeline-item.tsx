"use client";
// Timeline (roadmap) element on the board: time scale, lanes and bars that
// are dragged and resized right on the board once the element is selected.
// Bound to a database, the bars are its records: moving one changes the
// record's dates (the server checks the permissions, as everywhere). The
// records are never stored in the board: everyone sees only what they may
// read in the database.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal, api } from "../ui";
import { Select } from "../select";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { todayKey } from "@/lib/database-timeline";
import { parseTimeline, timelineScales, type TimelineData, type TimelineBar } from "@/lib/whiteboard-diagram-model";
import {
  barColors,
  barSvg,
  boundPatch,
  boundTimeline,
  changeBar,
  daysFor,
  defaultTimeline,
  fitText,
  laneAt,
  newId,
  timelineBackground,
  timelineLayout,
  type BarChange,
  type LaidBar,
} from "@/lib/whiteboard-timeline";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import type { Field, Row } from "@/lib/types";
import { useBoard } from "./board-context";

type Bound = { fields: Field[]; rows: Row[]; readOnly: Set<string>; canEdit: boolean };
// The records of a bound timeline, refreshed while the board is visible.
function useBoundRecords(pageId: string | undefined) {
  const [data, setData] = useState<Bound | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!pageId) return;
    let alive = true;
    const load = async () => {
      try {
        // Loading ahead does not count as visiting the database.
        const page = await api<{ role?: string; database?: { fields: Field[] }; rows?: Row[]; readOnlyFields?: string[] }>(`/api/pages/${pageId}`, undefined, {
          "X-Flowplan-Prefetch": "1",
        });
        if (!alive) return;
        if (!page.database) throw new Error("not a database");
        setData({ fields: page.database.fields, rows: page.rows || [], readOnly: new Set(page.readOnlyFields || []), canEdit: page.role !== "viewer" && page.role !== "commenter" });
        setError("");
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pageId, tick]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

type Drag = { bar: string; operation: BarChange["operation"]; x: number; y: number; barY: number; days: number; lane?: string; pointer: number };

export function TimelineItemView({ item, transform }: { item: WhiteboardItem; transform: string }) {
  const t = useT();
  const board = useBoard();
  const stored = useMemo(() => parseTimeline(item.timeline), [item.timeline]);
  const source = stored?.source;
  const bound = useBoundRecords(board && source ? source.pageId : undefined);
  const live = useMemo(() => {
    if (!stored || !source || !bound.data) return null;
    return boundTimeline(source, bound.data.fields, bound.data.rows, t("Ohne", "None"));
  }, [stored, source, bound.data, t]);
  const data: TimelineData | null = !stored ? null : !source ? stored : { ...stored, lanes: live?.valid ? live.lanes : [], bars: live?.valid ? live.bars : [] };
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const today = todayKey();
  const shown = useMemo(() => {
    if (!data) return null;
    const d = drag;
    const moved = d && (d.days || d.lane !== undefined) ? changeBar(data, d.bar, { operation: d.operation, days: d.days, lane: d.lane }) : data;
    return timelineLayout(item, moved, { today: data.today === false ? undefined : today, locale: LOCALE_TAG, weekLabel: t("KW", "W") });
  }, [data, drag, item, today, t]);
  const background = useMemo(
    () => (shown ? timelineBackground(item, shown, item.text || "") : ""),
    [shown, item],
  );
  if (!data || !shown)
    return (
      <g transform={transform}>
        <rect width={item.w} height={item.h} rx={8} fill="#f8f9fa" stroke="#adb5bd" strokeDasharray="6 4" />
        <text x={12} y={24} fontSize={13} fill="#868e96">
          {t("Zeitleiste ohne gültige Daten", "Timeline without valid data")}
        </text>
      </g>
    );
  const selected = !!board && board.selection.has(item.id) && board.selection.size === 1;
  const editable = !!board?.editable && selected && !item.locked && (!source || (!!bound.data?.canEdit && !bound.data.readOnly.has(source.startField)));
  const begin = (e: ReactPointerEvent, bar: LaidBar, operation: BarChange["operation"]) => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const next: Drag = { bar: bar.id, operation, x: e.clientX, y: e.clientY, barY: bar.y + bar.h / 2, days: 0, pointer: e.pointerId };
    dragRef.current = next;
    setDrag(next);
  };
  const move = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointer !== e.pointerId || !board) return;
    e.stopPropagation();
    const dx = (e.clientX - d.x) / board.zoom,
      dy = (e.clientY - d.y) / board.zoom;
    const lane = d.operation === "move" ? laneAt(shown, d.barY + dy) : undefined;
    const original = data.bars.find((b) => b.id === d.bar);
    const next = { ...d, days: daysFor(dx, shown), lane: lane !== undefined && lane !== original?.lane ? lane : undefined };
    if (next.days !== d.days || next.lane !== d.lane) {
      dragRef.current = next;
      setDrag(next);
    }
  };
  const end = async (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointer !== e.pointerId || !board) return;
    e.stopPropagation();
    dragRef.current = null;
    if (!d.days && d.lane === undefined) return setDrag(null);
    const change = { operation: d.operation, days: d.days, lane: d.lane };
    if (!source) {
      setDrag(null);
      board.transact(() => board.setProps(item.id, { timeline: changeBar(stored!, d.bar, change) }));
      return;
    }
    // A record: its dates (and the lane's option) change on the server.
    const row = bound.data?.rows.find((r) => r.id === d.bar);
    const bar = changeBar(data, d.bar, change).bars.find((b) => b.id === d.bar);
    if (!row || !bar) return setDrag(null);
    const cells: Record<string, unknown> = boundPatch(source, bar, row);
    if (d.lane !== undefined && source.laneField) cells[source.laneField] = d.lane.startsWith("o:") ? d.lane.slice(2) : "";
    try {
      await api("/api/command", { action: "row.update", pageId: source.pageId, rowId: row.id, version: row.version, cells });
    } catch (error) {
      board.onError((error as Error).message);
    } finally {
      bound.reload();
      setDrag(null);
    }
  };
  return (
    <g transform={transform} className={`wb-timeline${editable ? " editable" : ""}`}>
      <g dangerouslySetInnerHTML={{ __html: background }} />
      {shown.bars.map((bar) => (
        <g
          key={bar.id}
          className="wb-timeline-bar"
          data-bar={bar.id}
          onPointerDown={(e) => begin(e, bar, "move")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <title>{`${bar.title} · ${bar.start} – ${bar.end}`}</title>
          <g dangerouslySetInnerHTML={{ __html: barSvg(bar) }} />
          {editable && (
            <>
              <rect className="wb-timeline-grip" x={bar.x} y={bar.y} width={Math.min(8, bar.w / 3)} height={bar.h} onPointerDown={(e) => begin(e, bar, "resize-start")} />
              <rect className="wb-timeline-grip" x={bar.x + bar.w - Math.min(8, bar.w / 3)} y={bar.y} width={Math.min(8, bar.w / 3)} height={bar.h} onPointerDown={(e) => begin(e, bar, "resize-end")} />
            </>
          )}
        </g>
      ))}
      {source && bound.error && (
        <text x={shown.labelW + 8} y={item.h - 10} fontSize={12} fill="#e03131">
          {fitText(t("Datenbank nicht erreichbar", "Database not available"), item.w - shown.labelW, 12)}
        </text>
      )}
    </g>
  );
}

// A new timeline element (local id "n").
export function timelineDraft(t: (de: string, en: string) => string) {
  return {
    id: "n",
    type: "timeline" as const,
    x: 0,
    y: 0,
    w: 900,
    h: 260,
    text: t("Roadmap", "Roadmap"),
    timeline: defaultTimeline(todayKey(), [t("Team A", "Team A"), t("Team B", "Team B")], [t("Konzept", "Concept"), t("Umsetzung", "Delivery")]),
  };
}

// ---- editor ----

export function TimelineEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const board = useBoard();
  const item = board?.byId.get(id);
  const data = useMemo(() => parseTimeline(item?.timeline), [item?.timeline]);
  const [fields, setFields] = useState<Field[] | null>(null);
  const source = data?.source;
  useEffect(() => {
    if (!source?.pageId) return setFields(null);
    let alive = true;
    api<{ database?: { fields: Field[] } }>(`/api/pages/${source.pageId}`, undefined, { "X-Flowplan-Prefetch": "1" })
      .then((page) => alive && setFields(page.database?.fields || []))
      .catch((e) => {
        if (alive) board?.onError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [source?.pageId, board]);
  if (!board || !item || !data)
    return (
      <Modal open onClose={onClose} title={t("Zeitleiste bearbeiten", "Edit timeline")}>
        <p className="muted">{t("Die Zeitleiste ist nicht mehr da.", "The timeline is no longer there.")}</p>
      </Modal>
    );
  // Edits apply to the timeline as it is now, so quick edits in a row
  // never undo each other.
  const current = () => parseTimeline(board.live(id)?.timeline) || data;
  const save = (next: Partial<TimelineData> | ((now: TimelineData) => Partial<TimelineData>), props: Partial<WhiteboardItem> = {}) => {
    const now = current();
    board.transact(() => board.setProps(id, { ...props, timeline: { ...now, ...(typeof next === "function" ? next(now) : next) } }));
  };
  const setBar = (bar: TimelineBar, patch: Partial<TimelineBar>) =>
    save((now) => ({
      bars: now.bars.map((b) => {
        if (b.id !== bar.id) return b;
        const next = { ...b, ...patch };
        if (next.end < next.start) next.end = next.start;
        return next;
      }),
    }));
  const databases = board.pages.filter((p) => p.kind === "database");
  const dateFields = (fields || []).filter((f) => f.type === "date");
  const selectFields = (fields || []).filter((f) => f.type === "select");
  return (
    <Modal open onClose={onClose} title={t("Zeitleiste bearbeiten", "Edit timeline")} wide sheet>
      <div className="wb-timeline-editor">
        <div className="wb-timeline-grid">
          <label>
            {t("Titel", "Title")}
            <input value={item.text || ""} onChange={(e) => board.transact(() => board.setProps(id, { text: e.target.value.slice(0, 200) }))} />
          </label>
          <label>
            {t("Zeitskala", "Time scale")}
            <Select value={data.scale} onChange={(e) => save({ scale: e.target.value as TimelineData["scale"] })}>
              {timelineScales.map((s) => (
                <option key={s} value={s}>
                  {s === "week" ? t("Wochen", "Weeks") : s === "month" ? t("Monate", "Months") : t("Quartale", "Quarters")}
                </option>
              ))}
            </Select>
          </label>
          <label>
            {t("Von", "From")}
            <input type="date" value={data.start} onChange={(e) => e.target.value && save({ start: e.target.value, end: e.target.value > data.end ? e.target.value : data.end })} />
          </label>
          <label>
            {t("Bis", "Until")}
            <input type="date" value={data.end} min={data.start} onChange={(e) => e.target.value && save({ end: e.target.value < data.start ? data.start : e.target.value })} />
          </label>
          <label className="wb-check">
            <input type="checkbox" checked={data.today !== false} onChange={(e) => save({ today: e.target.checked ? undefined : false })} />
            {t("Heute markieren", "Mark today")}
          </label>
        </div>
        <fieldset>
          <legend>{t("Balken", "Bars")}</legend>
          <label>
            {t("Quelle", "Source")}
            <Select
              value={source?.pageId || ""}
              onChange={(e) => {
                const pageId = e.target.value;
                if (!pageId) save({ source: undefined });
                else save({ source: { pageId, startField: "" } as never });
              }}
            >
              <option value="">{t("Eigene Balken auf dem Board", "Own bars on the board")}</option>
              {databases.map((p) => (
                <option key={p.id} value={p.id}>
                  {t("Datenbank", "Database")}: {p.title || t("Ohne Titel", "Untitled")}
                </option>
              ))}
            </Select>
          </label>
          {source ? (
            <div className="wb-timeline-grid">
              {fields === null ? (
                <p className="muted">{t("Eigenschaften werden geladen …", "Loading properties …")}</p>
              ) : !dateFields.length ? (
                <p className="muted">{t("Diese Datenbank hat keine Datumseigenschaft.", "This database has no date property.")}</p>
              ) : (
                <>
                  <label>
                    {t("Beginn", "Start||date")}
                    <Select value={source.startField} onChange={(e) => save({ source: { ...source, startField: e.target.value } })}>
                      <option value="">{t("Auswählen …", "Choose …")}</option>
                      {dateFields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    {t("Ende", "End||date")}
                    <Select value={source.endField || ""} onChange={(e) => save({ source: { ...source, endField: e.target.value || undefined } })}>
                      <option value="">{t("Kein Enddatum", "No end date")}</option>
                      {dateFields
                        .filter((f) => f.id !== source.startField)
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                    </Select>
                  </label>
                  <label>
                    {t("Spuren nach", "Lanes by")}
                    <Select value={source.laneField || ""} onChange={(e) => save({ source: { ...source, laneField: e.target.value || undefined } })}>
                      <option value="">{t("Eine Spur", "One lane")}</option>
                      {selectFields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <p className="muted wb-timeline-note">
                    {t(
                      "Die Balken sind die Einträge der Datenbank. Verschieben und Ziehen an den Enden ändert ihre Daten – sofern du die Einträge bearbeiten darfst.",
                      "The bars are the database's records. Moving them or dragging their ends changes their dates – if you may edit the records.",
                    )}
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="wb-timeline-rows" role="list" aria-label={t("Spuren", "Lanes")}>
                {data.lanes.map((lane) => (
                  <div key={lane.id} role="listitem" className="wb-timeline-row">
                    <input
                      aria-label={t("Name der Spur", "Lane name")}
                      value={lane.name}
                      onChange={(e) => save((now) => ({ lanes: now.lanes.map((l) => (l.id === lane.id ? { ...l, name: e.target.value.slice(0, 120) } : l)) }))}
                    />
                    <button
                      type="button"
                      aria-label={t("Spur löschen", "Delete lane")}
                      disabled={data.lanes.length <= 1}
                      onClick={() => save((now) => ({ lanes: now.lanes.filter((l) => l.id !== lane.id), bars: now.bars.filter((b) => b.lane !== lane.id) }))}
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-button"
                  disabled={data.lanes.length >= 40}
                  onClick={() => save((now) => ({ lanes: [...now.lanes, { id: newId("l", now.lanes), name: t(`Spur ${now.lanes.length + 1}`, `Lane ${now.lanes.length + 1}`) }] }))}
                >
                  <Plus size={14} /> {t("Spur hinzufügen", "Add lane")}
                </button>
              </div>
              <div className="wb-timeline-rows" role="list" aria-label={t("Balken", "Bars")}>
                {data.bars.map((bar) => (
                  <div key={bar.id} role="listitem" className="wb-timeline-row bar">
                    <input aria-label={t("Titel des Balkens", "Bar title")} value={bar.title} onChange={(e) => setBar(bar, { title: e.target.value.slice(0, 200) })} />
                    <Select aria-label={t("Spur", "Lane")} value={bar.lane} onChange={(e) => setBar(bar, { lane: e.target.value })}>
                      {data.lanes.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name || "–"}
                        </option>
                      ))}
                    </Select>
                    <input type="date" aria-label={t("Beginn", "Start||date")} value={bar.start} onChange={(e) => e.target.value && setBar(bar, { start: e.target.value })} />
                    <input type="date" aria-label={t("Ende", "End||date")} value={bar.end} min={bar.start} onChange={(e) => e.target.value && setBar(bar, { end: e.target.value })} />
                    <span className="wb-timeline-colors" role="radiogroup" aria-label={t("Farbe", "Colour")}>
                      {barColors.map((c) => (
                        <button
                          key={c}
                          type="button"
                          role="radio"
                          aria-checked={(bar.color || barColors[0]) === c}
                          aria-label={t(`Farbe ${c}`, `Colour ${c}`)}
                          className={`wb-swatch${(bar.color || barColors[0]) === c ? " active" : ""}`}
                          style={{ background: c }}
                          onClick={() => setBar(bar, { color: c })}
                        />
                      ))}
                    </span>
                    <button type="button" aria-label={t("Balken löschen", "Delete bar")} onClick={() => save((now) => ({ bars: now.bars.filter((b) => b.id !== bar.id) }))}>
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-button"
                  disabled={data.bars.length >= 400}
                  onClick={() =>
                    save((now) => ({
                      bars: [
                        ...now.bars,
                        { id: newId("b", now.bars), lane: now.lanes[0]?.id || "", title: t("Neuer Balken", "New bar"), start: now.start, end: now.end < addDays(now.start, 13) ? now.end : addDays(now.start, 13), color: barColors[now.bars.length % barColors.length] },
                      ],
                    }))
                  }
                >
                  <Plus size={14} /> {t("Balken hinzufügen", "Add bar")}
                </button>
              </div>
            </>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}
const addDays = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
