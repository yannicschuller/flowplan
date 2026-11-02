"use client";
// Creating and changing a collection (#86): its name, an emoji, whether it
// is shared with the workspace, and its query – with the visual filter
// builder (groups with ALL/ANY, negation, conditions by kind) or as text in
// the search language (lib/collection-query.ts). Both show the same query:
// the builder writes the text, the text is read into the builder again
// (when the builder cannot show it, the text stays). Loaded on demand.
import { useEffect, useState } from "react";
import { Plus, Trash, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";
import {
  builderCanShow,
  DATE_PRESETS,
  fromBuilder,
  isGroup,
  joinDate,
  joinPropValue,
  parseQuery,
  queryText,
  splitDate,
  splitPropValue,
  toBuilder,
  type BuilderGroup,
  type Cond,
  type CondType,
  type DateParts,
  type PropOp,
  type QueryNode,
} from "@/lib/collection-query";
import type { Bootstrap } from "@/lib/types";
import type { CollectionItem } from "@/lib/collections";
import { typeName } from "./collection-view";

export type CollectionDraft = { id?: string; name: string; icon: string; query: string; shared: boolean; mine?: boolean };
type Act = (b: Record<string, unknown>) => Promise<unknown>;
type T = ReturnType<typeof useT>;

const MAX_DEPTH = 2;
const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export default function CollectionEditor({
  boot,
  draft,
  onClose,
  onSaved,
  act,
}: {
  boot: Bootstrap;
  draft: CollectionDraft;
  onClose: () => void;
  onSaved: (id: string) => void;
  act: Act;
}) {
  const t = useT();
  const [name, setName] = useState(draft.name),
    [icon, setIcon] = useState(draft.icon),
    [shared, setShared] = useState(draft.shared),
    [text, setText] = useState(() => queryText(parseQuery(draft.query).node) || draft.query),
    [mode, setMode] = useState<"builder" | "text">(() => (builderCanShow(draft.query) ? "builder" : "text")),
    [tree, setTree] = useState<BuilderGroup>(() => toBuilder(parseQuery(draft.query).node)),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false);
  const guest = !!boot.workspace.guest;
  // Only its creator shares a collection; guests do not share.
  const mayShare = !guest && (draft.mine ?? true);
  const editTree = (next: BuilderGroup) => {
    setTree(next);
    setText(queryText(fromBuilder(next)));
  };
  const toBuilderMode = () => {
    if (!builderCanShow(text)) {
      setNote(
        t(
          "Diese Abfrage lässt sich nicht als Filter darstellen (z. B. eine fehlende Klammer oder sehr tief verschachtelt). Bearbeite sie hier als Text.",
          "This query cannot be shown as filters (e.g. a missing parenthesis or very deep nesting). Edit it here as text.",
        ),
      );
      return;
    }
    setNote("");
    setTree(toBuilder(parseQuery(text).node));
    setMode("builder");
  };
  // Results of the query as it stands (debounced).
  const [preview, setPreview] = useState<{ total: number; items: CollectionItem[]; encryptedLeftOut: boolean } | null>(null);
  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/collections/preview?${new URLSearchParams({ workspace: boot.workspace.id, q: text, tz: zone() })}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((result) => setPreview(result))
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, boot.workspace.id]);
  const save = async () => {
    if (!name.trim() || !text.trim()) return;
    setBusy(true);
    const result = (await act(
      draft.id
        ? { action: "collection.update", collectionId: draft.id, name: name.trim(), icon: icon.trim(), query: text, ...(mayShare ? { shared } : {}) }
        : { action: "collection.create", workspaceId: boot.workspace.id, name: name.trim(), icon: icon.trim(), query: text, shared: mayShare && shared },
    )) as { id: string } | null;
    setBusy(false);
    if (result?.id) onSaved(result.id);
  };
  return (
    <Modal open onClose={onClose} title={draft.id ? t("Sammlung bearbeiten", "Edit collection") : t("Neue Sammlung", "New collection")} wide sheet className="collection-editor">
      <form
        className="collection-editor-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="collection-editor-head">
          <label className="collection-icon-field">
            <span>{t("Symbol", "Icon")}</span>
            <input value={icon} maxLength={8} placeholder="📁" onChange={(e) => setIcon(e.target.value)} aria-label={t("Emoji der Sammlung (optional)", "Emoji of the collection (optional)")} />
          </label>
          <label className="collection-name-field">
            <span>{t("Name", "Name")}</span>
            <input value={name} maxLength={120} required autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        {mayShare && (
          <label className="checkbox-label collection-share">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <span>
              {t("Mit dem Arbeitsbereich teilen", "Share with the workspace")}
              <small>
                {t(
                  "Alle Mitglieder (keine Gäste) sehen die Sammlung – jede Person nur die Ergebnisse, die sie lesen darf.",
                  "All members (not guests) see the collection – each person only the results they may read.",
                )}
              </small>
            </span>
          </label>
        )}
        <div className="collection-mode" role="tablist" aria-label={t("Abfrage bearbeiten als", "Edit the query as")}>
          <button type="button" role="tab" aria-selected={mode === "builder"} className={mode === "builder" ? "selected" : ""} onClick={toBuilderMode}>
            {t("Filter", "Filters")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "text"}
            className={mode === "text" ? "selected" : ""}
            onClick={() => {
              setNote("");
              setMode("text");
            }}
          >
            {t("Text", "Text")}
          </button>
        </div>
        {note && (
          <p className="collection-note" role="status">
            {note}
          </p>
        )}
        {mode === "builder" ? (
          <>
            <GroupEditor boot={boot} group={tree} depth={0} onChange={editTree} t={t} />
            <p className="collection-text-echo">
              <span>{t("Als Text:", "As text:")}</span> <code>{text || "–"}</code>
            </p>
          </>
        ) : (
          <label className="collection-text">
            <span>{t("Abfrage", "Query")}</span>
            <textarea value={text} rows={3} maxLength={1000} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder={'created_by:me #Projekt -#Erledigt updated:-7d'} />
            <small>
              {t(
                "Wörter, #Tag, -#Tag, Eigenschaft:Wert, OR, NOT, Klammern, created_by:, updated_by:, created:, updated: (-7d, this-week, 2026-03 …), type:, in:\"Bereich\", title:",
                "Words, #tag, -#tag, Property:value, OR, NOT, parentheses, created_by:, updated_by:, created:, updated: (-7d, this-week, 2026-03 …), type:, in:\"Space\", title:",
              )}
            </small>
          </label>
        )}
        <div className="collection-preview" aria-live="polite">
          {preview && (preview.total === 1 ? t("1 Treffer", "1 match") : t(`${preview.total} Treffer`, `${preview.total} matches`))}
          {preview && preview.total > 0 && ` – ${t("zum Beispiel:", "for example:")}`}
          {preview && preview.items.length > 0 && (
            <ul>
              {preview.items.slice(0, 5).map((i) => (
                <li key={i.rowId ?? i.pageId}>{i.title || t("Ohne Titel", "Untitled")}</li>
              ))}
            </ul>
          )}
          {preview?.encryptedLeftOut && <small>{t("Ende-zu-Ende-verschlüsselte Bereiche werden nicht durchsucht.", "End-to-end encrypted spaces are not searched.")}</small>}
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || !name.trim() || !text.trim()}>
            {t("Speichern", "Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- The builder ----

const FIELDS: { type: CondType; de: string; en: string }[] = [
  { type: "tag", de: "Tag", en: "Tag" },
  { type: "creator", de: "Erstellt von", en: "Created by" },
  { type: "editor", de: "Zuletzt geändert von", en: "Last edited by" },
  { type: "prop", de: "Eigenschaft", en: "Property" },
  { type: "created", de: "Erstellt am", en: "Created" },
  { type: "updated", de: "Geändert am", en: "Updated" },
  { type: "type", de: "Art", en: "Type" },
  { type: "in", de: "Bereich", en: "Space" },
  { type: "title", de: "Titel enthält", en: "Title contains" },
  { type: "text", de: "Text enthält", en: "Text contains" },
];
const newCond = (boot: Bootstrap, type: CondType): Cond => {
  switch (type) {
    case "tag":
      return { type, value: boot.taxonomy?.tags[0]?.name ?? "" };
    case "creator":
    case "editor":
      return { type, value: "me" };
    case "created":
    case "updated":
      return { type, value: "-7d" };
    case "type":
      return { type, value: "document" };
    case "in":
      return { type, value: boot.spaces[0]?.name ?? "" };
    case "prop": {
      const def = boot.taxonomy?.properties[0];
      return { type, name: def?.name ?? "", value: "*" };
    }
    default:
      return { type, value: "" };
  }
};

function GroupEditor({ boot, group, depth, onChange, onRemove, t }: { boot: Bootstrap; group: BuilderGroup; depth: number; onChange: (g: BuilderGroup) => void; onRemove?: () => void; t: T }) {
  const set = (i: number, node: QueryNode) => onChange({ ...group, items: group.items.map((x, j) => (j === i ? node : x)) });
  const remove = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) });
  return (
    <fieldset className={`collection-group depth-${depth}`}>
      <legend className="sr-only">{depth ? t("Gruppe", "Group") : t("Bedingungen", "Conditions")}</legend>
      <div className="collection-group-head">
        <Select
          aria-label={t("Verknüpfung der Bedingungen", "How conditions combine")}
          value={group.type}
          onChange={(e) => onChange({ ...group, type: e.target.value as "and" | "or" })}
        >
          <option value="and">{t("Alle Bedingungen (UND)", "All conditions (AND)")}</option>
          <option value="or">{t("Mindestens eine (ODER)", "Any condition (OR)")}</option>
        </Select>
        <label className="checkbox-label collection-not">
          <input type="checkbox" checked={!!group.not} onChange={(e) => onChange({ ...group, not: e.target.checked || undefined })} />
          {t("Gruppe ausschließen (NICHT)", "Exclude group (NOT)")}
        </label>
        {onRemove && (
          <button type="button" className="icon-button" aria-label={t("Gruppe entfernen", "Remove group")} onClick={onRemove}>
            <Trash size={15} />
          </button>
        )}
      </div>
      {!group.items.length && <p className="muted collection-empty">{t("Noch keine Bedingung – alle Seiten und Einträge.", "No condition yet – all pages and records.")}</p>}
      <ul className="collection-items">
        {group.items.map((item, i) => (
          <li key={i}>
            {isGroup(item) ? (
              <GroupEditor boot={boot} group={item} depth={depth + 1} onChange={(g) => set(i, g)} onRemove={() => remove(i)} t={t} />
            ) : (
              <CondEditor boot={boot} cond={item} onChange={(c) => set(i, c)} onRemove={() => remove(i)} t={t} />
            )}
          </li>
        ))}
      </ul>
      <div className="collection-group-actions">
        <button
          type="button"
          className="text-button"
          aria-label={t("Bedingung hinzufügen", "Add condition")}
          onClick={() => onChange({ ...group, items: [...group.items, newCond(boot, boot.taxonomy?.tags.length ? "tag" : "title")] })}
        >
          <Plus size={14} /> {t("Bedingung", "Condition")}
        </button>
        {depth < MAX_DEPTH && (
          <button
            type="button"
            className="text-button"
            aria-label={t("Gruppe hinzufügen", "Add group")}
            onClick={() => onChange({ ...group, items: [...group.items, { type: group.type === "and" ? "or" : "and", items: [newCond(boot, "tag")] }] })}
          >
            <Plus size={14} /> {t("Gruppe", "Group")}
          </button>
        )}
      </div>
    </fieldset>
  );
}

function CondEditor({ boot, cond, onChange, onRemove, t }: { boot: Bootstrap; cond: Cond; onChange: (c: Cond) => void; onRemove: () => void; t: T }) {
  const label = FIELDS.find((f) => f.type === cond.type);
  const what = label ? t(label.de, label.en) : cond.type;
  return (
    <div className="collection-cond" role="group" aria-label={t(`Bedingung: ${what}`, `Condition: ${what}`)}>
      <Select aria-label={t("Wonach filtern", "Filter by")} value={cond.type} onChange={(e) => onChange({ ...newCond(boot, e.target.value as CondType), ...(cond.not ? { not: true } : {}) })}>
        {FIELDS.map((f) => (
          <option key={f.type} value={f.type}>
            {t(f.de, f.en)}
          </option>
        ))}
      </Select>
      <Select aria-label={t("Einschließen oder ausschließen", "Include or exclude")} value={cond.not ? "not" : "is"} onChange={(e) => onChange({ ...cond, not: e.target.value === "not" || undefined })}>
        <option value="is">{cond.type === "tag" ? t("hat", "has") : t("ist", "is")}</option>
        <option value="not">{cond.type === "tag" ? t("hat nicht", "has not") : t("ist nicht", "is not")}</option>
      </Select>
      <ValueEditor boot={boot} cond={cond} onChange={onChange} t={t} />
      <button type="button" className="icon-button" aria-label={t(`Bedingung ${what} entfernen`, `Remove condition ${what}`)} onClick={onRemove}>
        <X size={15} />
      </button>
    </div>
  );
}

function ValueEditor({ boot, cond, onChange, t }: { boot: Bootstrap; cond: Cond; onChange: (c: Cond) => void; t: T }) {
  const value = (v: string) => onChange({ ...cond, value: v });
  const withCurrent = (list: string[]) => (cond.value && !list.includes(cond.value) ? [cond.value, ...list] : list);
  switch (cond.type) {
    case "tag": {
      const names = withCurrent((boot.taxonomy?.tags ?? []).map((x) => x.name));
      return (
        <Select aria-label={t("Tag", "Tag")} value={cond.value} onChange={(e) => value(e.target.value)}>
          {!names.length && <option value="">{t("Keine Tags", "No tags")}</option>}
          {names.map((n) => (
            <option key={n} value={n}>
              #{n}
            </option>
          ))}
        </Select>
      );
    }
    case "creator":
    case "editor": {
      const people = [...new Map([boot.user, ...boot.members].map((m) => [m.name, m])).keys()].filter((n) => n !== boot.user.name);
      const list = withCurrent(["me", ...people]);
      return (
        <Select aria-label={t("Person", "Person")} value={cond.value} onChange={(e) => value(e.target.value)}>
          {list.map((n) => (
            <option key={n} value={n}>
              {n === "me" ? t("mir", "me") : n}
            </option>
          ))}
        </Select>
      );
    }
    case "created":
    case "updated":
      return <DateEditor value={cond.value} onChange={value} t={t} />;
    case "type":
      return (
        <Select aria-label={t("Art", "Type")} value={cond.value} onChange={(e) => value(e.target.value)}>
          {withCurrent(["document", "database", "whiteboard", "record", "notebook", "journal"]).map((x) => (
            <option key={x} value={x}>
              {typeName(x, t)}
            </option>
          ))}
        </Select>
      );
    case "in": {
      const list = withCurrent(boot.spaces.map((s) => s.name));
      return (
        <Select aria-label={t("Bereich", "Space")} value={cond.value} onChange={(e) => value(e.target.value)}>
          {list.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      );
    }
    case "prop":
      return <PropEditor boot={boot} cond={cond} onChange={onChange} t={t} />;
    default:
      return (
        <input
          className="collection-input"
          value={cond.value}
          maxLength={200}
          aria-label={cond.type === "title" ? t("Wörter im Titel", "Words in the title") : t("Wörter", "Words")}
          placeholder={t("Wörter", "Words")}
          onChange={(e) => value(e.target.value)}
        />
      );
  }
}
function DateEditor({ value, onChange, t }: { value: string; onChange: (v: string) => void; t: T }) {
  const parts = splitDate(value);
  const set = (p: DateParts) => onChange(joinDate(p));
  const today = new Date().toISOString().slice(0, 10);
  const presets: Record<string, string> = {
    today: t("heute", "today"),
    yesterday: t("gestern", "yesterday"),
    "this-week": t("diese Woche", "this week"),
    "last-week": t("letzte Woche", "last week"),
    "this-month": t("diesen Monat", "this month"),
    "last-month": t("letzten Monat", "last month"),
    "this-year": t("dieses Jahr", "this year"),
    "last-year": t("letztes Jahr", "last year"),
  };
  return (
    <span className="collection-date">
      <Select
        aria-label={t("Zeitraum", "Period")}
        value={parts.mode}
        onChange={(e) => {
          const mode = e.target.value as DateParts["mode"];
          if (mode === "last") set({ mode, n: 7, unit: "d" });
          else if (mode === "preset") set({ mode, preset: "this-week" });
          else if (mode === "between") set({ mode, from: today, to: today });
          else if (mode === "custom") set({ mode, value: value });
          else set({ mode, date: today });
        }}
      >
        <option value="last">{t("in den letzten", "in the last")}</option>
        <option value="preset">{t("Zeitraum", "period")}</option>
        <option value="on">{t("am", "on")}</option>
        <option value="before">{t("vor dem", "before")}</option>
        <option value="after">{t("nach dem", "after")}</option>
        <option value="between">{t("zwischen", "between")}</option>
        <option value="custom">{t("Ausdruck", "expression")}</option>
      </Select>
      {parts.mode === "last" && (
        <>
          <input
            type="number"
            className="collection-input collection-number"
            min={1}
            max={9999}
            value={parts.n}
            aria-label={t("Anzahl", "Number")}
            onChange={(e) => set({ ...parts, n: Number(e.target.value) || 1 })}
          />
          <Select aria-label={t("Einheit", "Unit")} value={parts.unit} onChange={(e) => set({ ...parts, unit: e.target.value as "d" })}>
            <option value="d">{t("Tagen", "days")}</option>
            <option value="w">{t("Wochen", "weeks")}</option>
            <option value="m">{t("Monaten", "months")}</option>
            <option value="y">{t("Jahren", "years")}</option>
          </Select>
        </>
      )}
      {parts.mode === "preset" && (
        <Select aria-label={t("Zeitraum", "Period")} value={parts.preset} onChange={(e) => set({ mode: "preset", preset: e.target.value as (typeof DATE_PRESETS)[number] })}>
          {DATE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {presets[p]}
            </option>
          ))}
        </Select>
      )}
      {(parts.mode === "on" || parts.mode === "before" || parts.mode === "after") && (
        <input type="date" className="collection-input" value={parts.date} aria-label={t("Datum", "Date")} onChange={(e) => set({ ...parts, date: e.target.value })} />
      )}
      {parts.mode === "between" && (
        <>
          <input type="date" className="collection-input" value={parts.from} aria-label={t("Von", "From")} onChange={(e) => set({ ...parts, from: e.target.value })} />
          <input type="date" className="collection-input" value={parts.to} aria-label={t("Bis", "To")} onChange={(e) => set({ ...parts, to: e.target.value })} />
        </>
      )}
      {parts.mode === "custom" && (
        <input
          className="collection-input"
          value={parts.value}
          aria-label={t("Datumsausdruck, z. B. -30d oder 2026-03", "Date expression, e.g. -30d or 2026-03")}
          placeholder="-30d"
          onChange={(e) => set({ mode: "custom", value: e.target.value })}
        />
      )}
    </span>
  );
}

const OPS: Record<string, PropOp[]> = {
  select: ["is", "set", "empty"],
  multiselect: ["is", "set", "empty"],
  number: ["is", "gt", "lt", "gte", "lte", "between", "set", "empty"],
  date: ["is", "gt", "lt", "between", "set", "empty"],
  checkbox: ["is"],
  person: ["is", "set", "empty"],
};
function PropEditor({ boot, cond, onChange, t }: { boot: Bootstrap; cond: Cond; onChange: (c: Cond) => void; t: T }) {
  const defs = boot.taxonomy?.properties ?? [];
  const def = defs.find((d) => d.name.toLocaleLowerCase() === (cond.name ?? "").toLocaleLowerCase());
  const type = def?.type ?? "text";
  const kind = type === "created_at" || type === "updated_at" ? "date" : type === "created_by" || type === "updated_by" ? "person" : type;
  const ops = OPS[kind] ?? ["is", "set", "empty"];
  const parts = splitPropValue(cond.value, !!cond.quoted);
  const op = ops.includes(parts.op) ? parts.op : "is";
  const set = (nextOp: PropOp, v: string, to?: string) => {
    const joined = joinPropValue(nextOp, v, to);
    const next: Cond = { ...cond, value: joined.value };
    if (joined.quoted) next.quoted = true;
    else delete next.quoted;
    onChange(next);
  };
  const opLabel: Record<PropOp, string> = {
    is: kind === "text" || kind === "url" || kind === "email" || kind === "phone" ? t("enthält", "contains") : "=",
    contains: t("enthält", "contains"),
    gt: kind === "date" ? t("nach", "after") : ">",
    lt: kind === "date" ? t("vor", "before") : "<",
    gte: "≥",
    lte: "≤",
    between: t("zwischen", "between"),
    set: t("ist gesetzt", "is set"),
    empty: t("ist leer", "is empty"),
  };
  const names = def || !cond.name ? defs.map((d) => d.name) : [cond.name, ...defs.map((d) => d.name)];
  const input = (v: string, onValue: (v: string) => void, aria: string) => {
    if (kind === "select" || kind === "multiselect")
      return (
        <Select aria-label={aria} value={v} onChange={(e) => onValue(e.target.value)}>
          {[...(v && !def?.options.includes(v) ? [v] : []), ...(def?.options ?? [])].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    if (kind === "checkbox")
      return (
        <Select aria-label={aria} value={/^(yes|ja|oui|true|1|x|on|wahr)$/i.test(v) ? "yes" : "no"} onChange={(e) => onValue(e.target.value)}>
          <option value="yes">{t("ja", "yes")}</option>
          <option value="no">{t("nein", "no")}</option>
        </Select>
      );
    return (
      <input
        className="collection-input"
        type={kind === "date" && /^\d{4}-\d{2}-\d{2}$|^$/.test(v) ? "date" : kind === "number" ? "number" : "text"}
        value={v}
        aria-label={aria}
        placeholder={kind === "person" ? t("Name oder me", "Name or me") : ""}
        onChange={(e) => onValue(e.target.value)}
      />
    );
  };
  return (
    <span className="collection-prop">
      <Select aria-label={t("Eigenschaft", "Property")} value={cond.name ?? ""} onChange={(e) => onChange({ type: "prop", name: e.target.value, value: "*", ...(cond.not ? { not: true } : {}) })}>
        {!names.length && <option value="">{t("Keine Eigenschaften", "No properties")}</option>}
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
      {ops.length > 1 && (
        <Select aria-label={t("Vergleich", "Comparison")} value={op} onChange={(e) => {
            const next = e.target.value as PropOp;
            const keep = op === "set" || op === "empty" ? "" : parts.value;
            // A choice of options starts with the first one.
            set(next, !keep && next === "is" && def?.options[0] ? def.options[0] : keep, parts.to);
          }}
        >
          {ops.map((o) => (
            <option key={o} value={o}>
              {opLabel[o]}
            </option>
          ))}
        </Select>
      )}
      {op !== "set" && op !== "empty" && input(parts.value, (v) => set(op, v, parts.to), t("Wert", "Value"))}
      {op === "between" && input(parts.to ?? "", (v) => set(op, parts.value, v), t("bis", "to"))}
    </span>
  );
}
