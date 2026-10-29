"use client";
// Find on the page (⌘F / Ctrl+F, the keymap's "find"): a small bar that
// marks every match of the open screen and walks through them – also where
// there is no find of the browser (the desktop app, the apps with a
// keyboard). Matches are painted with the CSS Custom Highlight API, so the
// document (and the editor's DOM) stays untouched; without it the current
// match is only scrolled to. The text follows changes while the bar is open.
import { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, CaretUp, X } from "@phosphor-icons/react";
import { useT } from "./i18n";

const MAX = 2000;
const SKIP = "script, style, noscript, textarea, input, select, .find-bar, [aria-hidden='true'], [hidden]";

type HighlightRegistry = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const registry = () => (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
const Highlight = () => (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

// Where to look: the open screen, not the sidebar or the bars around it.
function findRoot() {
  return document.querySelector<HTMLElement>(".app-shell .main") || document.body;
}

// Every match of `query` (case-insensitive) in the visible text below `root`.
export function findRanges(root: Node, query: string): Range[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node && ranges.length < MAX; node = walker.nextNode()) {
    const parent = node.parentElement!;
    if (typeof parent.checkVisibility === "function" && !parent.checkVisibility()) continue;
    const text = (node.nodeValue || "").toLocaleLowerCase();
    for (let at = text.indexOf(needle); at >= 0 && ranges.length < MAX; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

function paint(ranges: Range[], current: number) {
  const highlights = registry();
  const Make = Highlight();
  if (!highlights || !Make) return;
  highlights.set("find-match", new Make(...ranges.filter((_, i) => i !== current)));
  if (ranges[current]) highlights.set("find-current", new Make(ranges[current]));
  else highlights.delete("find-current");
}
function clearPaint() {
  registry()?.delete("find-match");
  registry()?.delete("find-current");
}

function scrollTo(range: Range | undefined) {
  const element = range?.startContainer.parentElement;
  if (!element) return;
  const box = range!.getBoundingClientRect();
  // Only when it is not already comfortably in view.
  if (box.top < 80 || box.bottom > window.innerHeight - 80 || box.height === 0)
    element.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
}

export function FindInPage({ open, onClose, focusKey }: { open: boolean; onClose: () => void; focusKey: number }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  const search = useCallback((keepPosition: boolean) => {
    const found = findRanges(findRoot(), queryRef.current.trim());
    setRanges(found);
    setCurrent((c) => (keepPosition && c < found.length ? c : 0));
    return found;
  }, []);

  // Opening (and ⌘F again): the selected text, if short, becomes the query.
  useEffect(() => {
    if (!open) return;
    const selected = window.getSelection()?.toString().trim() || "";
    if (selected && selected.length <= 100 && !selected.includes("\n")) setQuery(selected);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [open, focusKey]);

  // A new query searches afresh (briefly debounced while typing).
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => scrollTo(search(false)[0]), 120);
    return () => window.clearTimeout(timer);
  }, [open, query, search]);

  // The page changes underneath (typing, loading, another page): search again.
  useEffect(() => {
    if (!open) return;
    let timer = 0;
    const observer = new MutationObserver((records) => {
      if (records.every((r) => (r.target as Element).closest?.(".find-bar"))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => search(true), 250);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [open, search]);

  useEffect(() => {
    if (open) paint(ranges, current);
    else clearPaint();
  }, [open, ranges, current]);
  useEffect(() => clearPaint, []);

  if (!open) return null;
  const step = (by: number) => {
    if (!ranges.length) return;
    const next = (current + by + ranges.length) % ranges.length;
    setCurrent(next);
    scrollTo(ranges[next]);
  };
  const count = !query.trim()
    ? ""
    : ranges.length
      ? `${current + 1}/${ranges.length >= MAX ? `${MAX}+` : ranges.length}`
      : t("Keine Treffer", "No matches");
  return (
    <div className="find-bar" role="search" aria-label={t("Auf der Seite suchen", "Find on page")}>
      <input
        ref={input}
        type="search"
        value={query}
        placeholder={t("Auf der Seite suchen", "Find on page")}
        aria-label={t("Auf der Seite suchen", "Find on page")}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {count}
      </span>
      <button type="button" className="icon-button" disabled={ranges.length < 2} aria-label={t("Vorheriger Treffer", "Previous match")} title={t("Vorheriger Treffer (⇧ Enter)", "Previous match (⇧ Enter)")} onClick={() => step(-1)}>
        <CaretUp size={14} />
      </button>
      <button type="button" className="icon-button" disabled={ranges.length < 2} aria-label={t("Nächster Treffer", "Next match")} title={t("Nächster Treffer (Enter)", "Next match (Enter)")} onClick={() => step(1)}>
        <CaretDown size={14} />
      </button>
      <button type="button" className="icon-button" aria-label={t("Suche schließen", "Close find")} title={t("Schließen (Esc)", "Close (Esc)")} onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}
