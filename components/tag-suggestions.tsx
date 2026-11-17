"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CaretDown } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { layerHost } from "./layer-host";
import { safeInsets } from "./safe-area";
import { insertTagToken, rankTags, tagFragmentAt } from "@/lib/tag-suggest";
import type { PageTag } from "@/lib/page-properties";

// Finding tags by typing (#328): the tag filter of the quick search
// (SearchTagFilter) and the suggestions after `#` in its input
// (TagSuggestList, driven by workspace-app). Both show the tags that match
// what was typed, the best first (lib/tag-suggest.ts), in the look of the
// styled select lists (.fp-select-list).

type Place = { host: HTMLElement; top: number; left: number; width: number; up: boolean };

// Under the anchor (above it when there is no room below), against the
// window; in the dialog the anchor sits in, so it stays inside its focus
// trap and takes clicks (components/layer-host.ts).
function placeAt(anchor: HTMLElement, minWidth: number): Place {
  const rect = anchor.getBoundingClientRect();
  const safe = safeInsets();
  const height = window.visualViewport?.height ?? window.innerHeight;
  const width = Math.min(Math.max(rect.width, minWidth), window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const below = height - safe.bottom - rect.bottom;
  const up = below < 200 && rect.top - safe.top > below;
  return { host: layerHost(anchor), top: up ? rect.top - 4 : rect.bottom + 4, left, width, up };
}

export function TagSuggestList({
  id,
  anchor,
  tags,
  active,
  onActive,
  onPick,
  hint,
  empty,
  label,
}: {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  tags: PageTag[];
  active: number;
  onActive: (index: number) => void;
  onPick: (tag: PageTag) => void;
  // Quieter text after the name (the tag's space, #136).
  hint?: (tag: PageTag) => string | undefined;
  // Shown instead of the list when nothing matches; without it, no popup.
  empty?: string;
  label: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);
  useLayoutEffect(() => {
    const reposition = () => anchor.current && setPlace(placeAt(anchor.current, 220));
    reposition();
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) reposition();
    };
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor]);
  useEffect(() => {
    list.current?.querySelector(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView({ block: "nearest" });
  }, [id, active]);
  if (!place || (!tags.length && !empty)) return null;
  return createPortal(
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label={label}
      data-layer=""
      className={`fp-select-list fixed tag-suggest-list${place.up ? " up" : ""}`}
      style={{ top: place.top, left: place.left, width: place.width }}
      // The focus stays in the field; a press only picks.
      onPointerDown={(e) => e.preventDefault()}
    >
      {tags.map((tag, i) => {
        const extra = hint?.(tag);
        return (
          <div
            key={tag.id}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            className={`fp-select-option${i === active ? " active" : ""}`}
            onPointerEnter={(e) => e.pointerType === "mouse" && onActive(i)}
            onClick={() => onPick(tag)}
          >
            <span className="tag-suggest-name">#{tag.name}</span>
            {extra && (
              <small className="tag-suggest-hint">
                <span className="sr-only">, </span>
                {extra}
              </small>
            )}
          </div>
        );
      })}
      {!tags.length && empty && (
        <p className="tag-suggest-empty" role="status">
          {empty}
        </p>
      )}
    </div>,
    place.host,
  );
}

// The tag filter: a text field that lists the matching tags while typing;
// the chosen one goes into the search query (onPick).
export function SearchTagFilter({
  tags,
  hint,
  onPick,
}: {
  tags: PageTag[];
  hint?: (tag: PageTag) => string | undefined;
  onPick: (tag: PageTag) => void;
}) {
  const t = useT();
  const id = useId();
  const listId = `${id}-tags`;
  const wrap = useRef<HTMLSpanElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const matches = useMemo(() => rankTags(tags, query), [tags, query]);
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const pick = (tag: PageTag | undefined) => {
    if (!tag) return;
    onPick(tag);
    setQuery("");
    setActive(0);
    setOpen(false);
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(e.key === "ArrowDown" ? 0 : Math.max(0, matches.length - 1));
      } else if (matches.length)
        setActive((current + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
    } else if (e.key === "Home" || e.key === "End") {
      if (!open || !matches.length) return;
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : matches.length - 1);
    } else if (e.key === "Enter") {
      // Never the search results' Enter: with nothing to pick it does nothing.
      e.preventDefault();
      if (open) pick(matches[current]);
      else setOpen(true);
    } else if (e.key === "Tab") {
      // Tab takes the highlighted tag when something was typed, and moves on.
      if (open && query.trim()) pick(matches[current]);
      setOpen(false);
    } else if (e.key === "Escape") {
      // The dialog leaves Escape to an open list (data-layer, components/ui.tsx).
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  const expanded = open && (matches.length > 0 || !!query.trim());
  return (
    <span ref={wrap} className="search-tag-filter" data-layer={expanded ? "" : undefined}>
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label={t("Nach Tag filtern", "Filter by tag")}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && matches.length ? `${listId}-${current}` : undefined}
        placeholder={t("Tag …", "Tag …")}
        value={query}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onPointerDown={() => setOpen(true)}
        onKeyDown={keyDown}
        onBlur={() => setOpen(false)}
      />
      <CaretDown className="search-tag-filter-caret" size={13} aria-hidden="true" />
      {expanded && (
        <TagSuggestList
          id={listId}
          anchor={wrap}
          tags={matches}
          active={current}
          onActive={setActive}
          onPick={pick}
          hint={hint}
          empty={t("Kein Tag gefunden", "No tag found")}
          label={t("Tags", "Tags")}
        />
      )}
    </span>
  );
}

// Suggestions after `#` in a text field (the quick search's input): while
// the caret is in a `#…` with at least one letter, the matching tags show
// under the field; ArrowUp/Down choose, Enter or Tab put the tag's token in
// place of what was typed, Escape closes. The field's own keys go first
// through `keyDown` – true when it took the key. Off while `disabled`
// (command mode) and during IME composition.
export function useTagSuggest({
  value,
  onChange,
  tags,
  disabled,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  tags: PageTag[];
  disabled?: boolean;
  hint?: (tag: PageTag) => string | undefined;
}) {
  const t = useT();
  const listId = `${useId()}-hash-tags`;
  const input = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState<number | null>(null),
    [composing, setComposing] = useState(false),
    [dismissed, setDismissed] = useState<number | null>(null),
    [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const fragment = !disabled && !composing && caret !== null ? tagFragmentAt(value, caret) : null;
  const typed = fragment?.query.trim() ?? "";
  const matches = useMemo(() => (typed ? rankTags(tags, typed).slice(0, 8) : []), [tags, typed]);
  const open = !!fragment && matches.length > 0 && dismissed !== fragment.start;
  const current = Math.min(active, Math.max(0, matches.length - 1));
  // A dismissed list comes back with the next `#`.
  useEffect(() => {
    if (!fragment && dismissed !== null) setDismissed(null);
  }, [fragment, dismissed]);
  // After an insertion: the caret behind the token.
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !input.current) return;
    pendingCaret.current = null;
    input.current.setSelectionRange(at, at);
    setCaret(at);
  }, [value]);
  const track = (el: HTMLInputElement) => setCaret(el.selectionStart !== null && el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  const pick = (tag: PageTag | undefined) => {
    if (!tag || !fragment) return;
    const next = insertTagToken(value, fragment, tag.name);
    pendingCaret.current = next.caret;
    setActive(0);
    onChange(next.value);
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      pick(matches[current]);
    } else if (e.key === "Escape") {
      // The dialog leaves Escape to the list (data-layer on the field).
      e.preventDefault();
      e.stopPropagation();
      setDismissed(fragment!.start);
    } else return false;
    return true;
  };
  return {
    open,
    listId,
    activeId: open ? `${listId}-${current}` : undefined,
    keyDown,
    // Spread onto the field (with its own onChange calling `changed`).
    fieldProps: {
      ref: input,
      "data-layer": open ? "" : undefined,
      onSelect: (e: { currentTarget: HTMLInputElement }) => track(e.currentTarget),
      onBlur: () => setCaret(null),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (e: { currentTarget: HTMLInputElement }) => {
        setComposing(false);
        track(e.currentTarget);
      },
    },
    changed: (el: HTMLInputElement) => {
      track(el);
      setActive(0);
    },
    list: open ? (
      <TagSuggestList
        id={listId}
        anchor={input}
        tags={matches}
        active={current}
        onActive={setActive}
        onPick={pick}
        hint={hint}
        label={t("Passende Tags", "Matching tags")}
      />
    ) : null,
  };
}
