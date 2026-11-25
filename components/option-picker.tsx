"use client";
// Select and multi-select values found by typing (#423): the value as its
// chip (a multi-select's as chips with ✕) and a search field with the
// property's options – case and accents aside, those starting with the
// text first. ArrowUp/Down move, Enter takes the highlighted one, Escape
// closes; a tap picks. Without an exact match, people who may change the
// database's properties get "„…“ anlegen": the option is added to the
// property (as from the column header) and set on the record in one go.
// A multi-select stays open for more. Like the tags' picker of
// tag-backed multi-selects (components/tag-cell-input.tsx, #79).
// While it is open the chosen values stand above the search as chips with
// ✕ (#426): Backspace in the empty search removes the last one (a select's
// value), ArrowLeft/Right move between the chips, Delete or Backspace on a
// chip removes it.
// Person properties with "Mehrere Personen" (#535) take the same picker:
// `people` are the members – their ids the options, found by name, shown
// as chips with the avatar.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check, Plus, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { listPlacement, type ListPlacement } from "./select";
import { choiceChipClass } from "@/lib/option-colors";
import { MAX_OPTION_LENGTH, searchOptions } from "@/lib/option-search";
import { isMultiPerson } from "@/lib/person-values";
import type { Field } from "@/lib/types";
import { Avatar } from "./ui";

// Adds the option to the property; true once it is there.
export type CreateOption = (name: string) => Promise<boolean>;

type Entry = { kind: "option" | "create"; value: string };
export type PickerPerson = { id: string; name: string };

// How the options look: a choice's chip, or a person's avatar and name.
type Look = {
  options: string[];
  person: boolean;
  nameOf: (option: string) => string;
  chip: (option: string) => string;
  content: (option: string) => ReactNode;
};
function useLook(field: Field, people: readonly PickerPerson[] | undefined): Look {
  const t = useT();
  if (!people)
    return { options: field.options || [], person: false, nameOf: (o) => o, chip: (o) => choiceChipClass(field, o), content: (o) => o };
  const names = new Map(people.map((p) => [p.id, p.name]));
  const nameOf = (o: string) => names.get(o) ?? t("Unbekannte Person", "Unknown person");
  return {
    options: people.map((p) => p.id),
    person: true,
    nameOf,
    chip: () => "tag tag-choice person-chip",
    content: (o) => (
      <>
        {/* The name is read out once: the initials are decoration. */}
        <span className="person-chip-avatar" aria-hidden="true">
          <Avatar name={nameOf(o)} userId={o} small />
        </span>
        <span className="person-chip-name">{nameOf(o)}</span>
      </>
    ),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : typeof value === "string" && value ? [value] : [];

export function OptionInput({
  field,
  value,
  disabled,
  editing,
  create,
  keep = false,
  people,
  onChange,
  onCancel,
}: {
  field: Field;
  // A person property (#535): the members to choose from.
  people?: readonly PickerPerson[];
  value: unknown;
  disabled?: boolean;
  // A required property (#443): the last value cannot be removed.
  keep?: boolean;
  // A table cell that was clicked: the search is open at once, and closing
  // it ends the edit (onCancel).
  editing?: boolean;
  // Only for people who may change the database's properties.
  create?: CreateOption;
  onChange: (v: unknown) => void | Promise<unknown>;
  onCancel?: () => void;
}) {
  const t = useT();
  const multi = field.type === "multiselect" || isMultiPerson(field);
  const look = useLook(field, people);
  const given = strings(value);
  const givenKey = JSON.stringify(given);
  // Picks made here count at once, before the record's new value is back
  // (several options in a row).
  const [chosen, setChosen] = useState(given);
  useEffect(() => setChosen(JSON.parse(givenKey) as string[]), [givenKey]);
  const [open, setOpen] = useState(!!editing && !disabled);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (editing) onCancel?.();
    else if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  };
  const latest = useRef(given);
  latest.current = given;
  const set = async (next: string[]) => {
    setChosen(next);
    const saved = await onChange(multi ? next : (next[0] ?? ""));
    // Refused (or nothing to save): the record's value again.
    if (!saved) setChosen(latest.current);
    return saved;
  };
  const chip = look.chip;
  const removable = !keep || chosen.length > 1;
  const search = open && !disabled && (
    <OptionSearch
      field={field}
      look={look}
      chosen={chosen}
      multi={multi}
      create={create}
      onPick={(o) => (multi ? (chosen.includes(o) ? undefined : set([...chosen, o])) : set([o]))}
      removable={removable}
      onRemove={(o) => set(chosen.filter((x) => x !== o))}
      onClose={close}
    />
  );
  if (!multi)
    return (
      <span className="option-input">
        {search || (
          <button
            type="button"
            ref={trigger}
            className="option-input-trigger"
            aria-haspopup="listbox"
            aria-expanded={false}
            aria-label={`${field.name}: ${chosen[0] || t("leer", "empty")}`}
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            {chosen[0] ? <span className={chip(chosen[0])}>{chosen[0]}</span> : <span className="muted">{t("Auswählen …", "Select …")}</span>}
            <CaretDown className="fp-select-caret" size={13} aria-hidden="true" />
          </button>
        )}
      </span>
    );
  return (
    <span className="option-input option-input-multi" role="group" aria-label={field.name}>
      {!search &&
        chosen.map((o) => (
        <span key={o} className={`${chip(o)} option-input-chip`}>
          {look.content(o)}
          {!disabled && removable && (
            <button
              type="button"
              className="page-tag-remove"
              aria-label={t(`„${look.nameOf(o)}“ entfernen`, `Remove “${look.nameOf(o)}”`)}
              onClick={() => void set(chosen.filter((x) => x !== o))}
            >
              <X size={11} weight="bold" />
            </button>
          )}
        </span>
      ))}
      {!disabled &&
        (search || (
          <button
            type="button"
            ref={trigger}
            className="page-properties-add option-input-add"
            aria-haspopup="listbox"
            aria-expanded={false}
            aria-label={
              look.person
                ? t(`Person zu „${field.name}“ hinzufügen`, `Add a person to “${field.name}”`)
                : t(`Option zu „${field.name}“ hinzufügen`, `Add an option to “${field.name}”`)
            }
            onClick={() => setOpen(true)}
          >
            <Plus size={13} aria-hidden /> {look.person ? t("Person", "Person") : t("Option", "Option")}
          </button>
        ))}
      {disabled && !chosen.length && <span className="muted">—</span>}
    </span>
  );
}

function OptionSearch({
  field,
  look,
  chosen,
  multi,
  create,
  onPick,
  onRemove,
  onClose,
  removable = true,
}: {
  field: Field;
  look: Look;
  chosen: string[];
  multi: boolean;
  create?: CreateOption;
  // False: the chosen value stays (a required property's last one, #443).
  removable?: boolean;
  onPick: (option: string) => unknown;
  onRemove: (option: string) => unknown;
  onClose: (refocus: boolean) => void;
}) {
  const t = useT();
  const listId = useId();
  const box = useRef<HTMLSpanElement>(null),
    input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [place, setPlace] = useState<ListPlacement | null>(null);
  const found = searchOptions(look.options, query, { exclude: multi ? chosen : [], canCreate: !!create && !look.person, labelOf: look.nameOf });
  const entries: Entry[] = [
    ...found.matches.map((value) => ({ kind: "option" as const, value })),
    ...(found.create ? [{ kind: "create" as const, value: found.create }] : []),
  ];
  // The chosen option is highlighted when the list opens.
  const [active, setActive] = useState(() => (multi ? 0 : Math.max(0, found.matches.indexOf(chosen[0] ?? ""))));
  const current = Math.min(active, entries.length - 1);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    return () => clearTimeout(blurTimer.current);
  }, []);
  // The list goes to the window (or the dialog), so a table's scroll area
  // does not cut it off; it follows the field when the page scrolls.
  useLayoutEffect(() => {
    const at = () => box.current && setPlace(listPlacement(box.current));
    at();
    const scrolled = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) at();
    };
    window.addEventListener("resize", at);
    window.addEventListener("scroll", scrolled, true);
    // A sheet or panel that slides in (a record's property on a phone,
    // #519) moves the field once its animation ends.
    window.addEventListener("animationend", scrolled, true);
    window.addEventListener("transitionend", scrolled, true);
    return () => {
      window.removeEventListener("resize", at);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("animationend", scrolled, true);
      window.removeEventListener("transitionend", scrolled, true);
    };
    // Chips added before the field move it.
  }, [chosen.length]);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !place) return;
    el.style.setProperty("--option-list-top", `${place.top}px`);
    el.style.setProperty("--option-list-left", `${place.left}px`);
    el.style.setProperty("--option-list-width", `${place.width}px`);
    // Not past the window's right edge (a cell at the right of a phone).
    const rect = el.getBoundingClientRect();
    const over = Math.min(rect.right - (window.innerWidth - 8), rect.left - 8);
    if (over > 0) el.style.setProperty("--option-list-left", `${place.left - over}px`);
  });
  useEffect(() => {
    if (current >= 0) document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, listId]);
  const pick = async (entry: Entry | undefined) => {
    if (!entry || busy) return;
    if (entry.kind === "create") {
      setBusy(true);
      try {
        if (!(await create?.(entry.value))) return;
      } finally {
        setBusy(false);
      }
    }
    setQuery("");
    setActive(0);
    void onPick(entry.value);
    if (!multi) onClose(true);
    else input.current?.focus({ preventScroll: true });
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, Math.min(entries.length - 1, current + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (entries[current]) void pick(entries[current]);
      else if (!query.trim()) onClose(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "Tab") onClose(false);
    else if (!query && chosen.length && removable && (e.key === "Backspace" || e.key === "ArrowLeft")) {
      // The empty search: Backspace removes the last value, ArrowLeft goes
      // to its chip.
      e.preventDefault();
      if (e.key === "ArrowLeft") chips()[chosen.length - 1]?.focus();
      else remove(chosen[chosen.length - 1]);
    }
  };
  const chips = () => [...(box.current?.querySelectorAll<HTMLButtonElement>(".option-picker-chosen button") || [])];
  const remove = (option: string) => {
    if (!removable) return;
    void onRemove(option);
    input.current?.focus({ preventScroll: true });
  };
  const chipKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if ((e.key === "Delete" || e.key === "Backspace") && removable) {
      e.preventDefault();
      const next = chips()[i + 1] ? i : i - 1;
      void onRemove(chosen[i]);
      // The chip after it (or before) takes the focus, the search at the end.
      requestAnimationFrame(() => (next >= 0 && multi ? chips()[next] : input.current)?.focus({ preventScroll: true }));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const to = chips()[i + (e.key === "ArrowLeft" ? -1 : 1)];
      if (to) to.focus();
      else if (e.key === "ArrowRight") input.current?.focus({ preventScroll: true });
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };
  // Leaving the picker (not to its chips or list) closes it after a moment
  // (taps on the list keep the focus); a search already gone – closed with
  // Enter or Escape – closes nothing (the next cell may be open by then).
  const left = (to: Node | null) => {
    if (box.current?.contains(to) || list.current?.contains(to)) return;
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      if (box.current && !box.current.contains(document.activeElement)) onClose(false);
    }, 120);
  };
  const label = (entry: Entry) =>
    entry.kind === "create" ? (
      <span className="option-picker-new">
        <Plus size={13} aria-hidden /> {t(`„${entry.value}“ anlegen`, `Create “${entry.value}”`)}
      </span>
    ) : (
      <span className={look.chip(entry.value)}>{look.content(entry.value)}</span>
    );
  const expanded = entries.length > 0;
  return (
    // data-layer: Escape closes the search, not the record's dialog
    // (components/layer-host.ts).
    <span ref={box} className="option-picker" data-layer="" onBlur={(e) => left(e.relatedTarget as Node | null)}>
      {chosen.length > 0 && (
        <span className="option-picker-chosen" role="group" aria-label={t(`Gewählt: ${field.name}`, `Chosen: ${field.name}`)}>
          {chosen.map((o, i) => (
            <span key={o} className={`${look.chip(o)} option-input-chip`}>
              {look.content(o)}
              {removable && (
                <button
                  type="button"
                  className="page-tag-remove"
                  aria-label={t(`„${look.nameOf(o)}“ entfernen`, `Remove “${look.nameOf(o)}”`)}
                  onKeyDown={(e) => chipKeyDown(e, i)}
                  onClick={() => remove(o)}
                >
                  <X size={11} weight="bold" />
                </button>
              )}
            </span>
          ))}
        </span>
      )}
      <input
        ref={input}
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && current >= 0 ? `${listId}-${current}` : undefined}
        aria-label={
          look.person
            ? t(`${field.name}: Person suchen`, `${field.name}: find a person`)
            : create
              ? t(`${field.name}: Option suchen oder anlegen`, `${field.name}: find or create an option`)
              : t(`${field.name}: Option suchen`, `${field.name}: find an option`)
        }
        aria-busy={busy || undefined}
        placeholder={create && !look.person ? t("Suchen oder anlegen …", "Find or create …") : t("Suchen …", "Find …")}
        autoComplete="off"
        enterKeyHint={multi ? "enter" : "done"}
        maxLength={MAX_OPTION_LENGTH}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={keyDown}
      />
      {place &&
        createPortal(
          <div
            ref={list}
            className={`fp-select-list option-picker-list${place.up ? " up" : ""}${place.fixed ? " fixed" : ""}`}
            // The focus stays in the field; a press or tap only picks.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div
              id={listId}
              role="listbox"
              aria-label={look.person ? t(`Mitglieder für ${field.name}`, `Members for ${field.name}`) : t(`Optionen von ${field.name}`, `Options of ${field.name}`)}
              aria-multiselectable={multi || undefined}
            >
              {entries.map((entry, i) => (
                <div
                  key={`${entry.kind}:${entry.value}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === current}
                  aria-disabled={busy || undefined}
                  className={`fp-select-option${i === current ? " active" : ""}${!multi && entry.kind === "option" && chosen[0] === entry.value ? " selected" : ""}`}
                  onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
                  onClick={() => void pick(entry)}
                >
                  {label(entry)}
                  {!multi && entry.kind === "option" && chosen[0] === entry.value && <Check size={14} aria-hidden />}
                </div>
              ))}
            </div>
            {!expanded && (
              <p className="option-picker-empty muted">
                {look.person
                  ? query.trim()
                    ? t("Keine passende Person.", "No matching person.")
                    : look.options.length
                      ? t("Alle Mitglieder sind gewählt.", "Every member is chosen.")
                      : t("Keine Mitglieder.", "No members.")
                  : query.trim()
                    ? t("Keine passende Option.", "No matching option.")
                    : multi && (field.options || []).length
                      ? t("Alle Optionen sind gewählt.", "Every option is chosen.")
                      : t("Noch keine Optionen.", "No options yet.")}
              </p>
            )}
          </div>,
          place.host,
        )}
      <span className="sr-only" role="status" aria-live="polite">
        {!query.trim()
          ? ""
          : look.person
            ? found.matches.length === 1
              ? t("1 Person", "1 person")
              : t(`${found.matches.length} Personen`, `${found.matches.length} people`)
            : found.matches.length === 1
              ? t("1 Option", "1 option")
              : t(`${found.matches.length} Optionen`, `${found.matches.length} options`)}
      </span>
    </span>
  );
}
