"use client";
import { useEffect, useState } from "react";
import { Flag, Play, CheckCircle, PencilSimple, Trash, Plus, ChartLine, DotsSixVertical } from "@phosphor-icons/react";
import { useT, useLocale } from "./i18n";
import { localeTag } from "@/lib/i18n";
import { Select } from "./select";
import { Modal, api } from "./ui";
import { cellText } from "@/lib/cell-text";
import { doneRule, isDone, type Sprint } from "@/lib/database-settings-schema";
import { ticketId } from "@/lib/ticket-ids";
import { usePointerDrag, type DragPoint } from "./pointer-drag";
import { keyboardStep } from "@/lib/pointer-drag";
import type { Database, Row, User } from "@/lib/types";

type Charts = {
  sprint: Sprint;
  unit: string | null;
  days: string[];
  remaining: (number | null)[];
  ideal: number[];
  total: number;
  velocity: { name: string; completed: number; committed: number }[];
};
// Sprint planning: the running sprint, planned sprints and the backlog.
// Records move between them by dragging (pointer events, components/
// pointer-drag.ts: the mouse on the record, by touch a long press on its
// handle), with the keyboard (Space on the handle, arrows, Space) or the
// "move to" choice.
export function DatabaseSprints({
  pageId,
  database,
  rows,
  members,
  editable,
  act,
  onOpen,
}: {
  pageId: string;
  database: Database;
  rows: Row[];
  members: Pick<User, "id" | "name">[];
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onOpen: (rowId: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const settings = database.settings || {};
  const fields = database.fields;
  const field = fields.find((f) => f.type === "sprint");
  const sprints = settings.sprints || [];
  const rule = doneRule(fields, settings);
  const pointsField = fields.find((f) => f.id === settings.pointsField);
  const idField = fields.find((f) => f.type === "id");
  const person = fields.find((f) => f.type === "person");
  const [editing, setEditing] = useState<Sprint | null>(null);
  const [completing, setCompleting] = useState<Sprint | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // A record lifted with the keyboard and the section it would go to.
  const [lifted, setLifted] = useState<{ id: string; at: number } | null>(null);
  const [status, setStatus] = useState("");
  const startDrag = usePointerDrag();
  const [busy, setBusy] = useState(false);
  const run = async (b: Record<string, unknown>) => {
    setBusy(true);
    try {
      return await act(b);
    } finally {
      setBusy(false);
    }
  };
  if (!field)
    return (
      <div className="sprint-setup">
        <Flag size={28} aria-hidden />
        <h3>{t("Sprints für diese Datenbank", "Sprints for this database")}</h3>
        <p className="muted">
          {t(
            "Plane Arbeit in Zeitabschnitten: Einträge aus dem Backlog in einen Sprint ziehen, den Sprint starten und am Ende abschließen – Offenes wandert in den nächsten. Burndown und Velocity zeigen den Verlauf.",
            "Plan work in time boxes: drag records from the backlog into a sprint, start it and complete it at the end – what is open moves to the next one. Burndown and velocity show how it goes.",
          )}
        </p>
        {editable && (
          <button className="button primary" disabled={busy} onClick={() => void run({ action: "sprint.setup" })}>
            {t("Sprints einrichten", "Set up sprints")}
          </button>
        )}
      </div>
    );
  const sprintOf = (r: Row) => String(r.cells[field.id] || "");
  const pts = (r: Row) => {
    if (!pointsField) return 1;
    const v = Number(r.cells[pointsField.id]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const open = sprints.filter((s) => s.state !== "closed");
  const closedIds = new Set(sprints.filter((s) => s.state === "closed").map((s) => s.id));
  const backlog = rows.filter((r) => !sprintOf(r) || (closedIds.has(sprintOf(r)) && !isDone(rule, r.cells)));
  const date = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(localeTag(locale), { day: "2-digit", month: "short" });
  const move = async (row: Row, target: string) => {
    if (target === sprintOf(row)) return;
    await run({ action: "row.update", rowId: row.id, version: row.version, cells: { [field.id]: target } });
  };
  // The sections in order: the open sprints, then the backlog.
  const zones = [...open.map((s) => ({ key: s.id, name: s.name })), { key: "backlog", name: t("Backlog", "Backlog") }];
  const zoneOf = (r: Row) => (closedIds.has(sprintOf(r)) || !sprintOf(r) ? "backlog" : sprintOf(r));
  const zoneAt = (point: DragPoint) =>
    point.target?.closest<HTMLElement>("[data-sprint-zone]")?.dataset.sprintZone ?? null;
  const dropZone = (key: string) => ({ "data-sprint-zone": key });
  function beginDrag(e: React.PointerEvent<HTMLElement>, row: Row, touch: "hold" | "none") {
    if (!editable || busy) return;
    if ((e.target as Element).closest("select")) return;
    const item = e.currentTarget.closest<HTMLElement>("li");
    startDrag(e, {
      touch,
      preview: item,
      source: item,
      onStart: () => setLifted(null),
      onMove: (point) => setOver(zoneAt(point)),
      onDrop: (point) => {
        setOver(null);
        const key = zoneAt(point);
        if (key) void move(row, key === "backlog" ? "" : key);
      },
      onCancel: () => setOver(null),
    });
  }
  function liftKey(e: React.KeyboardEvent<HTMLElement>, row: Row) {
    const name = cellText(row.cells[fields[0].id]) || t("Ohne Titel", "Untitled");
    if (lifted?.id !== row.id) {
      if (e.key !== " " || !editable || busy) return;
      e.preventDefault();
      const at = Math.max(0, zones.findIndex((z) => z.key === zoneOf(row)));
      setLifted({ id: row.id, at });
      setOver(zones[at].key);
      setStatus(t(`${name} angehoben, in „${zones[at].name}“. Pfeil hoch/runter wählt den Abschnitt, Leertaste oder Eingabe legt ab, Escape bricht ab.`, `${name} lifted, in “${zones[at].name}”. Arrow up/down chooses the section, Space or Enter drops, Escape cancels.`));
      return;
    }
    const step = keyboardStep({ list: 0, index: lifted.at }, e.key, [zones.length]);
    if (step.command === "none") return;
    e.preventDefault();
    if (step.command === "move") {
      setLifted({ id: row.id, at: step.position.index });
      setOver(zones[step.position.index].key);
      setStatus(zones[step.position.index].name);
      return;
    }
    setLifted(null);
    setOver(null);
    const key = zones[lifted.at].key;
    if (step.command === "cancel" || key === zoneOf(row)) {
      setStatus(step.command === "cancel" ? t(`Verschieben von ${name} abgebrochen.`, `Moving ${name} cancelled.`) : t(`${name} bleibt in „${zones[lifted.at].name}“.`, `${name} stays in “${zones[lifted.at].name}”.`));
      return;
    }
    setStatus(t(`${name} nach „${zones[lifted.at].name}“ verschoben.`, `${name} moved to “${zones[lifted.at].name}”.`));
    void move(row, key === "backlog" ? "" : key);
  }
  const list = (items: Row[]) =>
    items.length ? (
      <ul className="sprint-rows">
        {items.map((r) => (
          <li
            key={r.id}
            data-done={isDone(rule, r.cells)}
            data-lifted={lifted?.id === r.id ? "" : undefined}
            onPointerDown={(e) => {
              if (e.pointerType !== "touch") beginDrag(e, r, "none");
            }}
          >
            {editable && (
              <button
                type="button"
                className="sprint-row-handle"
                aria-label={t(`${cellText(r.cells[fields[0].id]) || "Ohne Titel"} verschieben`, `Move ${cellText(r.cells[fields[0].id]) || "Untitled"}`)}
                title={t("Ziehen (auf Touchscreens kurz halten) · Leertaste hebt an, Pfeiltasten wählen den Abschnitt", "Drag (on touch screens hold briefly) · Space lifts, arrow keys choose the section")}
                aria-keyshortcuts="Space"
                aria-pressed={lifted?.id === r.id ? true : undefined}
                disabled={busy}
                data-no-edge-swipe=""
                onPointerDown={(e) => {
                  e.stopPropagation();
                  beginDrag(e, r, "hold");
                }}
                onKeyDown={(e) => liftKey(e, r)}
                onKeyUp={(e) => {
                  if (e.key === " ") e.preventDefault();
                }}
                onBlur={() => {
                  if (lifted?.id === r.id) {
                    setLifted(null);
                    setOver(null);
                  }
                }}
              >
                <DotsSixVertical size={16} aria-hidden="true" />
              </button>
            )}
            {idField && <span className="sprint-row-id">{ticketId(idField, r.number)}</span>}
            <button type="button" className="sprint-row-title" onClick={() => onOpen(r.id)}>
              {cellText(r.cells[fields[0].id]) || t("Ohne Titel", "Untitled")}
            </button>
            {rule && <span className="sprint-row-status">{cellText(r.cells[rule.field.id])}</span>}
            {person && <span className="muted sprint-row-person">{members.find((m) => m.id === r.cells[person.id])?.name || ""}</span>}
            {pointsField && <span className="sprint-row-points">{pts(r) || "–"}</span>}
            {editable && (
              <Select aria-label={t("Verschieben nach", "Move to")} className="sprint-row-move" value={closedIds.has(sprintOf(r)) ? "" : sprintOf(r)} onChange={(e) => void move(r, e.target.value)}>
                <option value="">{t("Backlog", "Backlog")}</option>
                {open.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted sprint-empty">{editable ? t("Einträge hierher ziehen.", "Drag records here.") : t("Keine Einträge.", "No records.")}</p>
    );
  const sum = (items: Row[]) => items.reduce((s, r) => s + pts(r), 0);
  const unit = pointsField ? pointsField.name : t("Einträge", "records");
  return (
    <div className="sprints">
      <div className="sprints-bar">
        {editable && (
          <label>
            {t("Umfang messen in", "Measure size in")}
            <Select value={pointsField?.id || ""} onChange={(e) => void run({ action: "sprint.points", pointsField: e.target.value || null })}>
              <option value="">{t("Anzahl Einträge", "Number of records")}</option>
              {fields
                .filter((f) => f.type === "number")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </Select>
          </label>
        )}
        {editable && (
          <button className="button compact" disabled={busy} onClick={() => void run({ action: "sprint.create" })}>
            <Plus /> {t("Sprint", "Sprint")}
          </button>
        )}
      </div>
      {open.map((s) => {
        const items = rows.filter((r) => sprintOf(r) === s.id);
        const finished = items.filter((r) => isDone(rule, r.cells));
        return (
          <section key={s.id} className={`sprint-section sprint-${s.state}${over === s.id ? " drop" : ""}`} aria-label={s.name} {...dropZone(s.id)}>
            <header>
              <div>
                <h3>
                  {s.name}
                  {s.state === "active" && <span className="sprint-chip sprint-active">{t("läuft", "active")}</span>}
                </h3>
                <p className="muted">
                  {date(s.start)} – {date(s.end)} · {sum(finished)}/{sum(items)} {unit} {t("erledigt", "done")}
                </p>
                {s.goal && <p className="sprint-goal">{s.goal}</p>}
              </div>
              {editable && (
                <div className="sprint-actions">
                  {s.state === "planned" && (
                    <button className="button compact" disabled={busy || sprints.some((x) => x.state === "active")} onClick={() => void run({ action: "sprint.start", sprintId: s.id })}>
                      <Play /> {t("Starten", "Start||action")}
                    </button>
                  )}
                  {s.state === "active" && (
                    <button className="button compact primary" disabled={busy} onClick={() => setCompleting(s)}>
                      <CheckCircle /> {t("Abschließen", "Complete")}
                    </button>
                  )}
                  <button className="icon-button" aria-label={t(`${s.name} bearbeiten`, `Edit ${s.name}`)} onClick={() => setEditing(s)}>
                    <PencilSimple />
                  </button>
                  {s.state === "planned" && (
                    <button className="icon-button" aria-label={t(`${s.name} löschen`, `Delete ${s.name}`)} disabled={busy} onClick={() => void run({ action: "sprint.delete", sprintId: s.id })}>
                      <Trash />
                    </button>
                  )}
                </div>
              )}
            </header>
            {s.state === "active" && <SprintCharts pageId={pageId} sprintId={s.id} version={database.version + rows.length} />}
            {list(items)}
          </section>
        );
      })}
      <section className={`sprint-section sprint-backlog${over === "backlog" ? " drop" : ""}`} aria-label={t("Backlog", "Backlog")} {...dropZone("backlog")}>
        <header>
          <div>
            <h3>{t("Backlog", "Backlog")}</h3>
            <p className="muted">
              {backlog.length} {t("Einträge", "records")}
              {pointsField ? ` · ${sum(backlog)} ${pointsField.name}` : ""}
            </p>
          </div>
        </header>
        {list(backlog)}
      </section>
      {sprints.some((s) => s.state === "closed") && <Velocity sprints={sprints} unit={unit} />}
      <p role="status" className="sr-only">
        {status}
      </p>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={t("Sprint bearbeiten", "Edit sprint")}>
        {editing && (
          <SprintForm
            sprint={editing}
            busy={busy}
            onSave={async (next) => {
              if (await run({ action: "sprint.update", sprintId: editing.id, ...next })) setEditing(null);
            }}
          />
        )}
      </Modal>
      <Modal open={!!completing} onClose={() => setCompleting(null)} title={t("Sprint abschließen", "Complete sprint")}>
        {completing && (
          <CompleteSprint
            sprint={completing}
            open={rows.filter((r) => sprintOf(r) === completing.id && !isDone(rule, r.cells)).length}
            targets={open.filter((s) => s.id !== completing.id)}
            busy={busy}
            onComplete={async (moveTo) => {
              if (await run({ action: "sprint.complete", sprintId: completing.id, moveTo })) setCompleting(null);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function SprintForm({ sprint, busy, onSave }: { sprint: Sprint; busy: boolean; onSave: (s: Pick<Sprint, "name" | "start" | "end" | "goal">) => void }) {
  const t = useT();
  const [draft, setDraft] = useState({ name: sprint.name, start: sprint.start, end: sprint.end, goal: sprint.goal });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <label>
        {t("Name", "Name")}
        <input required maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <div className="form-row">
        <label>
          {t("Start", "Start")}
          <input type="date" required value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
        </label>
        <label>
          {t("Ende", "End")}
          <input type="date" required min={draft.start} value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
        </label>
      </div>
      <label>
        {t("Ziel", "Goal")}
        <textarea maxLength={500} value={draft.goal} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} />
      </label>
      <button className="button primary" disabled={busy}>
        {t("Speichern", "Save")}
      </button>
    </form>
  );
}

function CompleteSprint({ sprint, open, targets, busy, onComplete }: { sprint: Sprint; open: number; targets: Sprint[]; busy: boolean; onComplete: (moveTo: string) => void }) {
  const t = useT();
  const [target, setTarget] = useState(targets.find((s) => s.state === "planned")?.id || "backlog");
  return (
    <div className="complete-sprint">
      <p>
        {open
          ? t(`${open} Einträge in „${sprint.name}“ sind noch nicht erledigt. Wohin damit?`, `${open} records in “${sprint.name}” are not done yet. Where should they go?`)
          : t(`Alles in „${sprint.name}“ ist erledigt.`, `Everything in “${sprint.name}” is done.`)}
      </p>
      {open > 0 && (
        <Select aria-label={t("Offene Einträge verschieben nach", "Move open records to")} value={target} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value="backlog">{t("Backlog", "Backlog")}</option>
        </Select>
      )}
      <button className="button primary" disabled={busy} onClick={() => onComplete(target)}>
        {t("Sprint abschließen", "Complete sprint")}
      </button>
    </div>
  );
}

// Burndown of the running sprint: remaining work per day against the ideal.
function SprintCharts({ pageId, sprintId, version }: { pageId: string; sprintId: string; version: number }) {
  const t = useT();
  const [charts, setCharts] = useState<Charts | null>(null);
  const [show, setShow] = useState(true);
  useEffect(() => {
    void api<Charts>(`/api/sprint-charts?page=${pageId}&sprint=${sprintId}`)
      .then(setCharts)
      .catch(() => setCharts(null));
  }, [pageId, sprintId, version]);
  if (!charts || !charts.days.length) return null;
  const w = 560,
    h = 170,
    pad = 28;
  const max = Math.max(1, charts.total);
  const x = (i: number) => pad + (i / Math.max(1, charts.days.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad + 4 - (v / max) * (h - pad * 1.6);
  const actual = charts.remaining
    .map((v, i) => (v === null ? null : `${x(i)},${y(v)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <div className="sprint-chart">
      <button type="button" className="text-button" aria-expanded={show} onClick={() => setShow(!show)}>
        <ChartLine /> {t("Burndown", "Burndown")}
      </button>
      {show && (
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={t(`Burndown: noch ${charts.remaining.filter((v) => v !== null).at(-1) ?? charts.total} von ${charts.total}`, `Burndown: ${charts.remaining.filter((v) => v !== null).at(-1) ?? charts.total} of ${charts.total} left`)}>
          <line className="chart-axis" x1={pad} y1={h - pad + 4} x2={w - pad} y2={h - pad + 4} />
          <polyline className="chart-ideal" points={charts.ideal.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
          <polyline className="chart-actual" points={actual} />
          {charts.remaining.map((v, i) => v !== null && <circle key={i} className="chart-dot" cx={x(i)} cy={y(v)} r={3} />)}
          <text className="chart-label" x={pad} y={h - 6}>
            {charts.days[0].slice(5)}
          </text>
          <text className="chart-label" x={w - pad} y={h - 6} textAnchor="end">
            {charts.days.at(-1)!.slice(5)}
          </text>
          <text className="chart-label" x={pad - 6} y={y(max) + 4} textAnchor="end">
            {charts.total}
          </text>
        </svg>
      )}
    </div>
  );
}

// Velocity: completed against committed for the last closed sprints.
function Velocity({ sprints, unit }: { sprints: Sprint[]; unit: string }) {
  const t = useT();
  const closed = sprints.filter((s) => s.state === "closed").slice(-8);
  const max = Math.max(1, ...closed.map((s) => Math.max(s.committed ?? 0, s.completed ?? 0)));
  const average = closed.reduce((s, x) => s + (x.completed ?? 0), 0) / closed.length;
  return (
    <section className="sprint-section sprint-velocity" aria-label={t("Velocity", "Velocity")}>
      <header>
        <div>
          <h3>{t("Velocity", "Velocity")}</h3>
          <p className="muted">
            {t("Durchschnitt", "Average")} {Math.round(average * 10) / 10} {unit} {t("pro Sprint", "per sprint")}
          </p>
        </div>
      </header>
      <div className="velocity-bars">
        {closed.map((s) => (
          <div key={s.id} className="velocity-bar" title={`${s.name}: ${s.completed ?? 0}/${s.committed ?? 0}`}>
            <span className="velocity-committed" style={{ height: `${((s.committed ?? 0) / max) * 100}%` }} />
            <span className="velocity-completed" style={{ height: `${((s.completed ?? 0) / max) * 100}%` }} />
            <small>{s.name}</small>
          </div>
        ))}
      </div>
      <p className="muted velocity-legend">
        <span className="velocity-key completed" /> {t("erledigt", "completed")} <span className="velocity-key committed" /> {t("geplant", "committed")}
      </p>
    </section>
  );
}

