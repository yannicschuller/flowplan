"use client";
// The row of emoji suggestions next to the caret (#388, opened by
// components/emoji-suggest.tsx): up to ten emojis in one row, the first one
// chosen, its name below. ←/→ move, Enter or Tab insert, a click or tap
// inserts; on phones the row scrolls sideways. Loaded with the emoji data
// the first time a ":" trigger shows.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale, useT } from "./i18n";
import { loadEmojiEntries, type EmojiEntry } from "@/lib/emoji-data";
import { exactEmoji, rankEmojis, readEmojiRecents, readEmojiTone, rememberEmoji } from "@/lib/emoji-rank";
import type { EmojiTrigger } from "@/lib/emoji-trigger";
import { placeAtCaret } from "@/lib/caret-popover";
import { popoverArea } from "./slash-menu";
import type { EmojiSuggestController } from "./emoji-suggest";

export default function EmojiSuggestMenu({
  controller,
  trigger,
  container,
}: {
  controller: EmojiSuggestController;
  trigger: EmojiTrigger;
  container: HTMLElement | null;
}) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<EmojiEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    void loadEmojiEntries(locale)
      .then((list) => alive && setEntries(list))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [locale]);
  // Read once per opening: the recently used emojis and the picker's tone.
  const [recents, setRecents] = useState(readEmojiRecents);
  const [tone] = useState(readEmojiTone);
  const items = useMemo(() => (entries ? rankEmojis(entries, trigger.query, { recents, tone }) : []), [entries, trigger.query, recents, tone]);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [trigger.query]);
  const chosen = Math.min(active, Math.max(0, items.length - 1));
  const nameOf = (entry: EmojiEntry) => (locale === "de" ? entry.label : entry.labelEn);
  const pick = (index: number) => {
    const entry = items[index];
    if (entry) controller.insert(entry.emoji);
  };
  // What the editor's keys reach (the extension takes ←/→, Enter, Tab and
  // Escape only while the row shows emojis).
  controller.row = {
    count: items.length,
    move: (step) => items.length && setActive((i) => (Math.min(i, items.length - 1) + step + items.length) % items.length),
    pick: () => pick(chosen),
  };
  useEffect(
    () => () => {
      controller.row = null;
    },
    [controller],
  );
  // The closing colon (":smile:") and the recently used emojis need the
  // data: kept on the controller once it is loaded, also after the row closes.
  useEffect(() => {
    if (!entries) return;
    controller.exact = (query) => exactEmoji(entries, query, tone);
    controller.remember = (emoji) => {
      const entry = entries.find((e) => e.emoji === emoji);
      if (entry) setRecents(rememberEmoji(entry));
    };
  }, [controller, entries, tone]);
  // The chosen emoji stays visible while moving with the arrow keys.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(`[data-index="${chosen}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [chosen]);
  // Next to the colon, inside the part of the screen the person sees (as
  // the "/" menu, lib/caret-popover.ts); placed through the element's style
  // object, no style attribute (strict CSP).
  const [, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", again);
    vv?.addEventListener("scroll", again);
    const scrolled = (event: Event) => {
      if (!(event.target instanceof Node && box.current?.contains(event.target))) again();
    };
    window.addEventListener("scroll", scrolled, true);
    return () => {
      vv?.removeEventListener("resize", again);
      vv?.removeEventListener("scroll", again);
      window.removeEventListener("scroll", scrolled, true);
    };
  }, []);
  useLayoutEffect(() => {
    const el = box.current,
      view = controller.view;
    if (!el || !view || view.isDestroyed) return;
    let caret: { left: number; top: number; bottom: number };
    try {
      caret = view.coordsAtPos(Math.min(trigger.from, view.state.doc.content.size));
    } catch {
      return;
    }
    const place = placeAtCaret(caret, el.offsetHeight, popoverArea(el), { max: 120 });
    el.style.left = `${Math.max(8, Math.min(caret.left, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${place.top}px`;
  });
  if (!items.length) return null;
  const selected = items[chosen];
  return createPortal(
    <div
      ref={box}
      className="emoji-suggest"
      data-no-edge-swipe=""
      // Clicks and taps keep the caret (and the keyboard) in the text.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        className="emoji-suggest-list"
        role="listbox"
        aria-orientation="horizontal"
        aria-label={t("Emoji-Vorschläge", "Emoji suggestions")}
        aria-activedescendant={`${id}-${chosen}`}
      >
        {items.map((entry, index) => (
          <button
            key={entry.hexcode}
            type="button"
            role="option"
            id={`${id}-${index}`}
            data-index={index}
            aria-selected={index === chosen}
            aria-label={`${entry.emoji} ${nameOf(entry)}`}
            title={entry.shortcodes[0] ? `${nameOf(entry)} :${entry.shortcodes[0]}:` : nameOf(entry)}
            onMouseMove={() => index !== chosen && setActive(index)}
            onClick={() => pick(index)}
          >
            {entry.emoji}
          </button>
        ))}
      </div>
      <p className="emoji-suggest-name" aria-live="polite">
        <span>{nameOf(selected)}</span>
        {selected.shortcodes[0] && <code>:{selected.shortcodes[0]}:</code>}
      </p>
    </div>,
    container || document.body,
  );
}
