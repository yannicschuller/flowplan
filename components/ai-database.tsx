"use client";
// AI in databases (lib/ai/database.ts): the editor of an AI property, "Für
// alle ausfüllen", "Neu berechnen" in a record, "Mit KI ausfüllen" for
// selected records, the queue status with a short highlight of freshly
// filled cells, and "Mit KI erstellen" when a database is created.
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Sparkle, Trash } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { api, Modal } from "./ui";
import { Select } from "./select";
import { aiProviderLabel, type AiStatus } from "@/lib/ai/client";
import { localeTag } from "@/lib/i18n";
import type { Field, FieldType } from "@/lib/types";

export const AI_OUTPUT_TYPES: FieldType[] = ["text", "select", "multiselect", "number"];
const FILL_TYPES: FieldType[] = ["text", "number", "select", "multiselect", "checkbox", "date", "url", "email", "phone"];
const REFERENCE_TYPES: FieldType[] = ["text", "number", "date", "select", "multiselect", "checkbox", "url", "email", "phone", "checklist", "person", "created_at", "updated_at", "created_by", "updated_by", "id", "relation"];
type Meta = Record<string, Record<string, { at: number; model: string; status: string }>>;
export type AiDatabaseStatus = { pending: number; mine: number; meta: Meta };

// Unknown {references} of a prompt (shown before saving; the server checks too).
export function unknownReferences(prompt: string, fields: Field[], self: string) {
  return [...prompt.matchAll(/\{([^{}\n]{1,100})\}/g)]
    .map((m) => m[1].trim())
    .filter((name) => {
      const f = fields.find((x) => x.id === name || x.name.trim().toLowerCase() === name.toLowerCase());
      if (!f) return !["inhalt", "content", "contenu"].includes(name.toLowerCase());
      return f.id === self || !REFERENCE_TYPES.includes(f.type);
    });
}

// The part of the property dialog for an AI property.
export function AiFieldEditor({
  draft,
  fields,
  onChange,
  disabled,
}: {
  draft: Field;
  fields: Field[];
  onChange: (patch: Partial<Field>) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const prompt = draft.ai?.prompt || "";
  const area = useRef<HTMLTextAreaElement | null>(null);
  const unknown = unknownReferences(prompt, fields, draft.id);
  const insert = (name: string) => {
    const el = area.current;
    const at = el ? el.selectionStart : prompt.length;
    const next = `${prompt.slice(0, at)}{${name}}${prompt.slice(el ? el.selectionEnd : at)}`;
    onChange({ ai: { ...draft.ai, prompt: next } });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + name.length + 2, at + name.length + 2);
    });
  };
  return (
    <div className="ai-field-editor">
      <label>
        {t("Ausgabe", "Output")}
        <Select
          aria-label={t("Art des Ergebnisses", "Kind of result")}
          value={draft.type}
          disabled={disabled}
          onChange={(e) => onChange({ type: e.target.value as FieldType })}
        >
          <option value="text">{t("Text", "Text")}</option>
          <option value="select">{t("Auswahl (nur vorhandene Optionen)", "Select (existing options only)")}</option>
          <option value="multiselect">{t("Mehrfachauswahl (nur vorhandene Optionen)", "Multi-select (existing options only)")}</option>
          <option value="number">{t("Zahl", "Number")}</option>
        </Select>
      </label>
      <label>
        {t("Auftrag an die KI", "Instruction for the AI")}
        <textarea
          ref={area}
          rows={4}
          maxLength={2000}
          required
          disabled={disabled}
          value={prompt}
          placeholder={t("z. B. Fasse {Beschreibung} in einem Satz zusammen", "e.g. Summarize {Description} in one sentence")}
          onChange={(e) => onChange({ ai: { ...draft.ai, prompt: e.target.value } })}
        />
      </label>
      <div className="ai-field-references" aria-label={t("Eigenschaft einfügen", "Insert property")}>
        {fields
          .filter((f) => f.id !== draft.id && REFERENCE_TYPES.includes(f.type))
          .map((f) => (
            <button key={f.id} type="button" className="chip" disabled={disabled} onClick={() => insert(f.name)}>
              {`{${f.name}}`}
            </button>
          ))}
        {!fields.some((f) => ["inhalt", "content", "contenu"].includes(f.name.trim().toLowerCase())) && (
          <button type="button" className="chip" disabled={disabled} onClick={() => insert(t("Inhalt", "Content"))} title={t("Der Seiteninhalt des Eintrags", "The record's page content")}>
            {t("{Inhalt}", "{Content}")}
          </button>
        )}
      </div>
      {unknown.length > 0 && (
        <p className="form-error" role="alert">
          {t(`Unbekannt oder nicht verwendbar: ${unknown.map((n) => `{${n}}`).join(", ")}`, `Unknown or not usable: ${unknown.map((n) => `{${n}}`).join(", ")}`)}
        </p>
      )}
      <label className="checkbox-label">
        <input type="checkbox" checked={!!draft.ai?.auto} disabled={disabled} onChange={(e) => onChange({ ai: { prompt, auto: e.target.checked } })} />
        {t("Automatisch neu berechnen, wenn sich verwendete Eigenschaften ändern", "Recompute automatically when the properties used change")}
      </label>
      <small className="muted">
        {draft.ai?.auto
          ? t(
              "Läuft in deinem Namen und mit deinen KI-Einstellungen, verzögert und im Rahmen deiner KI-Kontingente. Verlierst du den Zugriff, stoppt es.",
              "Runs in your name and with your AI settings, delayed and within your AI limits. If you lose access, it stops.",
            )
          : t("Werte werden berechnet, wenn du „Für alle ausfüllen“ oder in einem Eintrag „Neu berechnen“ wählst.", "Values are computed when you choose “Fill in for all” or “Recompute” in a record.")}
      </small>
    </div>
  );
}

// Polls the queue while values are pending; cells whose value was just
// computed are returned in `fresh` for a short highlight.
export function useAiDatabaseStatus(pageId: string, active: boolean, onRefresh: () => Promise<unknown>) {
  const [status, setStatus] = useState<AiDatabaseStatus | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const previous = useRef<Meta | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = async () => {
    try {
      const next = await api<AiDatabaseStatus>(`/api/ai/database/status?page=${pageId}`);
      const before = previous.current;
      previous.current = next.meta;
      setStatus((current) => {
        if (current && (current.pending !== next.pending || JSON.stringify(current.meta) !== JSON.stringify(next.meta))) void onRefresh().catch(() => {});
        return next;
      });
      if (before) {
        const changed = new Set<string>();
        for (const [rowId, fields] of Object.entries(next.meta))
          for (const [fieldId, m] of Object.entries(fields)) if (m.status === "ok" && (before[rowId]?.[fieldId]?.at || 0) < m.at) changed.add(`${rowId}:${fieldId}`);
        if (changed.size) {
          setFresh(changed);
          setTimeout(() => setFresh(new Set()), 1400);
        }
      }
      return next;
    } catch {
      return null;
    }
  };
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = async () => {
      const next = await load();
      if (!stopped && next?.pending) timer.current = setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pageId, active]);
  // After queuing: poll until the queue is empty.
  const watch = () => {
    if (timer.current) clearTimeout(timer.current);
    const poll = async () => {
      const next = await load();
      if (next?.pending) timer.current = setTimeout(poll, 2500);
    };
    timer.current = setTimeout(poll, 1200);
  };
  return { status, fresh, reload: load, watch };
}

const errorText = (e: unknown) => (e as Error).message;

// "Für alle ausfüllen" for an AI property (in the property dialog).
export function AiFillAll({ pageId, field, onQueued, onError }: { pageId: string; field: Field; onQueued: (n: number) => void; onError: (m: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="button compact"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ queued: number }>("/api/ai/database/queue", { pageId, fieldId: field.id, mode: "compute" });
          onQueued(r.queued);
        } catch (e) {
          onError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Sparkle size={14} /> {t("Für alle ausfüllen", "Fill in for all")}
    </button>
  );
}

// In a record: when and with what the value was computed, and recompute.
export function AiCellControl({
  pageId,
  field,
  rowId,
  meta,
  editable,
  onDone,
  onError,
}: {
  pageId: string;
  field: Field;
  rowId: string;
  meta?: { at: number; model: string; status: string };
  editable: boolean;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const when = meta?.at ? new Date(meta.at).toLocaleString(localeTag(locale), { dateStyle: "short", timeStyle: "short" }) : "";
  return (
    <div className="ai-cell-control">
      <Sparkle size={13} aria-hidden />
      <small className="muted">
        {meta?.status === "blocked"
          ? t("Für die KI gesperrt", "Closed to the AI")
          : meta?.status === "error"
            ? t("Konnte nicht berechnet werden", "Could not be computed")
            : meta?.at
              ? meta.model
                ? t(`KI · ${when} · ${meta.model}`, `AI · ${when} · ${meta.model}`)
                : t(`KI · ${when} · ohne Eingaben`, `AI · ${when} · no inputs`)
              : t("KI-Eigenschaft · noch nicht berechnet", "AI property · not computed yet")}
      </small>
      {editable && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/api/ai/database/cell", { pageId, fieldId: field.id, rowId, mode: "compute" });
              onDone();
            } catch (e) {
              onError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <ArrowClockwise size={13} className={busy ? "spin" : undefined} /> {busy ? t("Wird berechnet …", "Computing …") : t("Neu berechnen", "Recompute")}
        </button>
      )}
    </div>
  );
}

// "Mit KI ausfüllen" for the selected records.
export function AiFillDialog({
  open,
  pageId,
  fields,
  rowIds,
  ai,
  onClose,
  onQueued,
  onError,
}: {
  open: boolean;
  pageId: string;
  fields: Field[];
  rowIds: string[];
  ai: AiStatus | undefined;
  onClose: () => void;
  onQueued: (n: number, skipped: number) => void;
  onError: (m: string) => void;
}) {
  const t = useT();
  const candidates = fields.filter((f, i) => i > 0 && FILL_TYPES.includes(f.type) && !f.ai);
  const [fieldId, setFieldId] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = candidates.find((f) => f.id === fieldId) || candidates[0];
  return (
    <Modal open={open} onClose={onClose} title={t("Mit KI ausfüllen", "Fill in with AI")}>
      {candidates.length ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!chosen) return;
            setBusy(true);
            try {
              const r = await api<{ queued: number; skipped: number }>("/api/ai/database/queue", { pageId, fieldId: chosen.id, rowIds, mode: "fill" });
              onQueued(r.queued, r.skipped);
              onClose();
            } catch (err) {
              onError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Eigenschaft", "Property")}
            <Select value={chosen?.id || ""} onChange={(e) => setFieldId(e.target.value)}>
              {candidates.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </label>
          <p className="muted">
            {t(
              `Die KI füllt „${chosen?.name}“ in ${rowIds.length} ausgewählten Einträgen aus – nur wo das Feld leer ist, aus Titel, übrigen Eigenschaften und Inhalt.${chosen && ["select", "multiselect"].includes(chosen.type) ? " Nur vorhandene Optionen werden verwendet." : ""}`,
              `The AI fills in “${chosen?.name}” in ${rowIds.length} selected records – only where it is empty, from the title, the other properties and the content.${chosen && ["select", "multiselect"].includes(chosen.type) ? " Only existing options are used." : ""}`,
            )}
          </p>
          <p className="muted">
            <Sparkle size={13} /> {aiProviderLabel(ai?.provider ?? null, t)}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary" disabled={busy}>
              {t("Ausfüllen", "Fill in")}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">{t("Keine Eigenschaft, die sich mit KI ausfüllen lässt (Text, Zahl, Auswahl, Datum, Checkbox, URL, E-Mail, Telefon).", "No property that can be filled in with AI (text, number, select, date, checkbox, URL, email, phone).")}</p>
      )}
    </Modal>
  );
}

// ---- "Mit KI erstellen" ----

export type DatabaseProposal = {
  title: string;
  fields: { name: string; type: string; options?: string[] }[];
  rows: Record<string, unknown>[];
  // Unticked in the review: no example records.
  useRows?: boolean;
};
// i18n-table: 1 – [German, English] pairs
const TYPE_NAMES: Record<string, [string, string]> = {
  text: ["Text", "Text"],
  number: ["Zahl", "Number"],
  date: ["Datum", "Date"],
  select: ["Auswahl", "Select||property type"],
  multiselect: ["Mehrfachauswahl", "Multi-select"],
  checkbox: ["Checkbox", "Checkbox"],
  url: ["URL", "URL"],
  email: ["E-Mail", "Email"],
  phone: ["Telefon", "Phone"],
};
const valueText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "✓" : "–") : String(v ?? ""));

// Describe → proposal → review (rename, remove, examples on/off). The
// reviewed proposal is what the creation sends; the server checks it again.
export function AiDatabaseCreator({
  workspaceId,
  ai,
  proposal,
  onProposal,
  onTitle,
  onError,
}: {
  workspaceId: string;
  ai: AiStatus | undefined;
  proposal: DatabaseProposal | null;
  onProposal: (p: DatabaseProposal | null) => void;
  onTitle: (title: string) => void;
  onError: (m: string) => void;
}) {
  const t = useT();
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const propose = async () => {
    setBusy(true);
    try {
      const r = await api<{ proposal: DatabaseProposal }>("/api/ai/database/propose", { workspaceId, description });
      onProposal(r.proposal);
      if (r.proposal.title) onTitle(r.proposal.title);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (next: DatabaseProposal) => onProposal(next);
  return (
    <div className="ai-database-creator">
      <label>
        {t("Beschreibe die Datenbank", "Describe the database")}
        <textarea
          rows={2}
          maxLength={2000}
          value={description}
          placeholder={t("z. B. Leseliste mit Autor, Genre, Status, Bewertung", "e.g. Reading list with author, genre, status, rating")}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="ai-database-creator-actions">
        <button type="button" className="button compact" disabled={busy || description.trim().length < 3} onClick={() => void propose()}>
          <Sparkle size={14} /> {busy ? t("Schlägt vor …", "Proposing …") : proposal ? t("Neu vorschlagen", "Propose again") : t("Vorschlag erstellen", "Create proposal")}
        </button>
        <small className="muted">{aiProviderLabel(ai?.provider ?? null, t)}</small>
      </div>
      {busy && <div className="ai-proposal-loading" aria-hidden />}
      {proposal && !busy && (
        <div className="ai-proposal" aria-label={t("Vorschlag prüfen", "Review proposal")}>
          <p className="muted">{t("Prüfe den Vorschlag. Erst „Seite erstellen“ legt die Datenbank an.", "Review the proposal. Only “Create page” creates the database.")}</p>
          <ul>
            {proposal.fields.map((f, i) => (
              <li key={i}>
                <input
                  aria-label={t("Name der Eigenschaft", "Property name")}
                  value={f.name}
                  maxLength={60}
                  onChange={(e) => {
                    const old = f.name;
                    const name = e.target.value;
                    update({
                      ...proposal,
                      fields: proposal.fields.map((x, j) => (j === i ? { ...x, name } : x)),
                      rows: proposal.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k === old ? name : k, v]))),
                    });
                  }}
                />
                <span className="chip">{t(...(TYPE_NAMES[f.type] || [f.type, f.type]))}</span>
                {f.options && <small className="muted">{f.options.join(", ")}</small>}
                {i > 0 && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t(`${f.name} entfernen`, `Remove ${f.name}`)}
                    onClick={() =>
                      update({
                        ...proposal,
                        fields: proposal.fields.filter((_, j) => j !== i),
                        rows: proposal.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== f.name))),
                      })
                    }
                  >
                    <Trash size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {proposal.rows.length > 0 && (
            <>
              <label className="checkbox-label">
                <input type="checkbox" checked={proposal.useRows !== false} onChange={(e) => update({ ...proposal, useRows: e.target.checked })} />
                {t(`${proposal.rows.length} Beispieleinträge anlegen`, `Create ${proposal.rows.length} example records`)}
              </label>
              {proposal.useRows !== false && (
                <div className="ai-proposal-rows">
                  {proposal.rows.map((r, i) => (
                    <small key={i} className="muted">
                      {proposal.fields
                        .map((f) => valueText(r[f.name]))
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
// What the creation sends (the server checks it again).
export const proposalPayload = (p: DatabaseProposal) => ({ title: p.title, fields: p.fields, rows: p.useRows === false ? [] : p.rows });
