"use client";
// A form's one-line text question (#374). With `suggest` (members-only
// forms where the author switched suggestions on) it is a combobox: from
// the second character it lists earlier answers from the server
// (lib/form-suggestions.ts); ArrowUp/Down choose, Enter takes one, Escape
// closes, a tap picks. Without it the browser's own form history may offer
// what was typed on this device before: the field keeps a stable name per
// question and autocomplete on – nothing is stored by Flowplan.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "./i18n";
import type { Field } from "@/lib/types";

export type SuggestSource = (fieldId: string, query: string) => Promise<string[]>;
const MIN_CHARS = 2;

// The value with the typed part in bold.
function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (at < 0 || !query.trim()) return <>{text}</>;
  const end = at + query.trim().length;
  return (
    <>
      {text.slice(0, at)}
      <strong>{text.slice(at, end)}</strong>
      {text.slice(end)}
    </>
  );
}

export function FormSuggestInput({
  field,
  value,
  disabled,
  placeholder,
  suggest,
  onChange,
}: {
  field: Field;
  value: unknown;
  disabled?: boolean;
  placeholder?: string;
  suggest?: SuggestSource;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const listId = `${useId()}-suggestions`;
  const text = typeof value === "string" ? value : "";
  const [items, setItems] = useState<string[]>([]),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(-1),
    [focused, setFocused] = useState(false);
  // Answers per query, for this question while the page is open.
  const cache = useRef(new Map<string, string[]>());
  const query = text.trim();
  useEffect(() => {
    if (!suggest || !focused || query.length < MIN_CHARS) {
      setItems([]);
      return;
    }
    const key = query.toLocaleLowerCase();
    const known = cache.current.get(key);
    if (known) {
      setItems(known);
      return;
    }
    let live = true;
    // A short pause after typing before asking the server.
    const timer = setTimeout(() => {
      suggest(field.id, query).then(
        (list) => {
          cache.current.set(key, list);
          if (live) setItems(list);
        },
        () => live && setItems([]),
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [suggest, field.id, query, focused]);
  const expanded = !!suggest && open && focused && items.length > 0;
  const current = active < items.length ? active : -1;
  const pick = (choice: string | undefined) => {
    if (choice === undefined) return;
    onChange(choice);
    setOpen(false);
    setActive(-1);
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!suggest || e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(e.key === "ArrowDown" ? 0 : items.length - 1);
      } else setActive((current + (e.key === "ArrowDown" ? 1 : items.length - (current < 0 ? 0 : 1))) % items.length);
    } else if (e.key === "Enter" && expanded && current >= 0) {
      // Takes the highlighted answer instead of sending the form.
      e.preventDefault();
      pick(items[current]);
    } else if (e.key === "Escape" && expanded) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };
  if (!suggest)
    return (
      <input
        aria-label={field.name}
        type="text"
        // The browser's form history for this question on this device.
        name={`flowplan-question-${field.id}`}
        autoComplete="on"
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <div className="form-suggest">
      <input
        aria-label={field.name}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && current >= 0 ? `${listId}-${current}` : undefined}
        // Our list replaces the browser's, so the two never overlap.
        autoComplete="off"
        name={`flowplan-question-${field.id}`}
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => {
          setFocused(true);
          setOpen(true);
        }}
        onBlur={() => {
          setFocused(false);
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={keyDown}
      />
      <div
        id={listId}
        role="listbox"
        aria-label={t(`Frühere Antworten für ${field.name}`, `Earlier answers for ${field.name}`)}
        className="fp-select-list form-suggest-list"
        hidden={!expanded}
        // The focus stays in the field; a press or tap only picks.
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
      >
        {expanded &&
          items.map((item, i) => (
            <div
              key={item}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              className={`fp-select-option${i === current ? " active" : ""}`}
              onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
              onClick={() => pick(item)}
            >
              <span className="form-suggest-text">
                <Highlight text={item} query={query} />
              </span>
            </div>
          ))}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {expanded ? t(`${items.length} frühere Antworten`, `${items.length} earlier answers`) : ""}
      </span>
    </div>
  );
}

// Suggestions from the form's endpoint; failures (rate limit, offline)
// just show none.
export function formSuggestSource(token: string): SuggestSource {
  return async (fieldId, query) => {
    const response = await fetch(`/api/forms/${encodeURIComponent(token)}/suggestions?${new URLSearchParams({ field: fieldId, q: query })}`, { cache: "no-store" });
    if (!response.ok) return [];
    const data = (await response.json().catch(() => ({}))) as { suggestions?: unknown };
    return Array.isArray(data.suggestions) ? data.suggestions.filter((s): s is string => typeof s === "string") : [];
  };
}
