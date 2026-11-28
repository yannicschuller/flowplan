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
import { listPlacement, visibleArea, type ListPlacement } from "./select";
import { onKeyboardMove, scrollPane } from "./mobile-tab-bar";
import { safeInsets } from "./safe-area";
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

// A finger is the main input (lib/keyboard-hints.ts uses the same query).
const TOUCH_INPUT = "(hover: none) and (pointer: coarse)";
// A list in a sheet on a touch screen (#625): at least two rows of 44 px
// show, and below three the sheet scrolls the search up where it can.
const MIN_LIST = 2 * 44 + 10;
const FEW_ROWS = 3 * 44 + 10;
// Where a list below a field has to end: at the end of the visible area,
// less the home indicator – or, with the keyboard up, above "Hide keyboard"
// (components/hide-keyboard-button.tsx), which sits right above it.
function visibleEnd() {
  const end = visibleArea().end;
  const fab = document.querySelector(".hide-keyboard-fab")?.getBoundingClientRect();
  if (fab && fab.height && fab.top < end) return fab.top - 8;
  return end - safeInsets().bottom - 8;
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
    [place, setPlace] = useState<ListPlacement | null>(null),
    // In a sheet on a touch screen the list stands below the search in the
    // sheet itself (#625), instead of floating over the window.
    [inline, setInline] = useState(false);
  const found = searchOptions(look.options, query, { exclude: multi ? chosen : [], canCreate: !!create && !look.person, labelOf: look.nameOf });
  const entries: Entry[] = [
    ...found.matches.map((value) => ({ kind: "option" as const, value })),
    ...(found.create ? [{ kind: "create" as const, value: found.create }] : []),
  ];
  // The chosen option is highlighted when the list opens.
  const [active, setActive] = useState(() => (multi ? 0 : Math.max(0, found.matches.indexOf(chosen[0] ?? ""))));
  const current = Math.min(active, entries.length - 1);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // On a touch screen the list opens without the keyboard, which would hide
  // most of it; a tap on the field brings it up to search (#625). There a
  // tap outside closes the list, not the field losing the focus: hiding the
  // keyboard blurs it, and the list must stay.
  const touch = useRef(typeof matchMedia === "function" && matchMedia(TOUCH_INPUT).matches);
  // Back to the search after a pick or a removed chip – not on touch:
  // focusing it would bring the keyboard up again.
  const refocus = () => {
    if (!touch.current) input.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!touch.current) {
      input.current?.focus({ preventScroll: true });
      return () => clearTimeout(blurTimer.current);
    }
    // The tap outside closes once it is over – after its click – not as the
    // finger comes down (#625): closing then took the record's sheet away
    // with the list, and the click that follows a tap landed on what lay
    // under the finger by then (the sheet's ✕ opened the property behind
    // it). So the click reaches what was tapped (the ✕ closes the sheet),
    // never what only shows once the list is gone. A tap that turns into a
    // scroll (pointercancel) or a drag closes nothing.
    let tap: { id: number; x: number; y: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      tap = null;
      clearTimeout(timer);
      // After the click has gone everywhere it goes.
      timer = setTimeout(() => onCloseRef.current(false), 0);
    };
    const down = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (box.current?.contains(target) || list.current?.contains(target)) return;
      // The floating "hide keyboard" button (components/hide-keyboard-button.tsx).
      if (target instanceof Element && target.closest(".hide-keyboard-fab")) return;
      tap = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const cancel = (e: PointerEvent) => {
      if (tap?.id === e.pointerId) tap = null;
    };
    // No click follows a tap whose touchend something cancelled (or one on
    // a disabled control): a tap that stayed in place closes all the same,
    // a moment later.
    const up = (e: PointerEvent) => {
      if (!tap || tap.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) {
        tap = null;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => tap && close(), 600);
    };
    const click = () => {
      if (tap) close();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("click", click, true);
    return () => {
      clearTimeout(blurTimer.current);
      clearTimeout(timer);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("click", click, true);
    };
  }, []);
  // The list goes to the window (or the dialog), so a table's scroll area
  // does not cut it off; it follows the field when the page scrolls.
  useLayoutEffect(() => {
    // In a sheet on a touch screen: in the sheet, below the search (#625).
    // Placed against the window, the list had to follow the field through
    // the keyboard's coming and going, and the iOS keyboard moves the
    // visible area without a resize or scroll of the window.
    if (touch.current && box.current?.closest(".modal-sheet")) {
      setInline(true);
      return;
    }
    const at = () => box.current && setPlace(listPlacement(box.current));
    at();
    const scrolled = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) at();
    };
    window.addEventListener("resize", at);
    window.addEventListener("scroll", scrolled, true);
    // The keyboard comes and goes (and iOS moves the visible area) without
    // a resize of the window.
    const vv = touch.current ? window.visualViewport : null;
    vv?.addEventListener("resize", at);
    vv?.addEventListener("scroll", at);
    // A sheet or panel that slides in (a record's property on a phone,
    // #519) moves the field once its animation ends.
    window.addEventListener("animationend", scrolled, true);
    window.addEventListener("transitionend", scrolled, true);
    return () => {
      vv?.removeEventListener("resize", at);
      vv?.removeEventListener("scroll", at);
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
    // On a touch screen no taller than the room to the visible edge, the
    // keyboard's included; it scrolls inside.
    if (touch.current) el.style.setProperty("--option-list-max", `${Math.max(MIN_LIST, Math.floor(place.room))}px`);
    // Not past the window's right edge (a cell at the right of a phone).
    const rect = el.getBoundingClientRect();
    const over = Math.min(rect.right - (window.innerWidth - 8), rect.left - 8);
    if (over > 0) el.style.setProperty("--option-list-left", `${place.left - over}px`);
  });
  // In the sheet (#625): the list ends where the visible area does – above
  // the keyboard and "Hide keyboard" – and scrolls inside. When the keyboard
  // comes up and leaves less than three rows below the search, the sheet
  // scrolls the search up as far as it can.
  useEffect(() => {
    if (!inline) return;
    const vv = window.visualViewport;
    let frame = 0;
    const fit = (reveal: boolean) => {
      const el = list.current,
        field = input.current;
      if (!el || !field) return;
      let room = visibleEnd() - el.getBoundingClientRect().top;
      if (reveal && room < FEW_ROWS && document.activeElement === field) {
        const pane = scrollPane(box.current);
        const above = field.getBoundingClientRect().top - (visibleArea().top + safeInsets().top + 8);
        if (pane && above > 0) {
          const before = pane.scrollTop;
          pane.scrollTop += Math.min(FEW_ROWS - room, above);
          room += pane.scrollTop - before;
        }
      }
      el.style.setProperty("--option-list-max", `${Math.max(MIN_LIST, Math.floor(room))}px`);
    };
    const later = (reveal: boolean) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit(reveal));
    };
    const keyboard = () => later(true);
    const moved = () => later(false);
    // A tap on the search brings the keyboard up; iOS reports its size late
    // (and "Hide keyboard" shows a moment later).
    let timers: ReturnType<typeof setTimeout>[] = [];
    const focused = () => {
      keyboard();
      for (const timer of timers) clearTimeout(timer);
      timers = [150, 450, 900].map((ms) => setTimeout(keyboard, ms));
    };
    fit(false);
    vv?.addEventListener("resize", keyboard);
    vv?.addEventListener("scroll", moved);
    window.addEventListener("resize", keyboard);
    // The keyboard watcher's late measurements (iOS reports the keyboard
    // late, sometimes without an event).
    const stop = onKeyboardMove(keyboard);
    const field = input.current;
    field?.addEventListener("focus", focused);
    // The sheet sliding in, growing or scrolling.
    const sheet = box.current?.closest<HTMLElement>(".modal-sheet");
    const ro = sheet && typeof ResizeObserver !== "undefined" ? new ResizeObserver(moved) : null;
    if (sheet) ro?.observe(sheet);
    sheet?.addEventListener("animationend", moved);
    sheet?.addEventListener("scroll", moved);
    return () => {
      cancelAnimationFrame(frame);
      for (const timer of timers) clearTimeout(timer);
      stop();
      ro?.disconnect();
      vv?.removeEventListener("resize", keyboard);
      vv?.removeEventListener("scroll", moved);
      window.removeEventListener("resize", keyboard);
      field?.removeEventListener("focus", focused);
      sheet?.removeEventListener("animationend", moved);
      sheet?.removeEventListener("scroll", moved);
    };
  }, [inline]);
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
    else refocus();
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
    refocus();
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
    // Touch: hiding the keyboard blurs the field; a tap outside closes (above).
    if (touch.current) return;
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
  // The list: in the sheet below the search, or over the window (or dialog).
  const portal = (el: ReactNode) => (inline ? el : place ? createPortal(el, place.host) : null);
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
        // Not focused on opening on a touch screen (#625), nor by the
        // record's panel around it (components/record-property-value.tsx).
        data-no-autofocus={touch.current ? "" : undefined}
        enterKeyHint={multi ? "enter" : "done"}
        maxLength={MAX_OPTION_LENGTH}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={keyDown}
      />
      {portal(
        <div
          ref={list}
          className={`fp-select-list option-picker-list${inline ? " inline" : `${place?.up ? " up" : ""}${place?.fixed ? " fixed" : ""}`}`}
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
