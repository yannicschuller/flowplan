"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import { useT } from "./i18n";
import {
  canonicalLanguage,
  codeLanguages,
  isKnownLanguage,
  languageLabel,
  readRecentLanguages,
  searchLanguages,
  type CodeLanguage,
} from "@/lib/code-languages";

// The language of a code block: a button with the full name, opening a
// searchable list (names, ids, aliases, file extensions) with the person's
// recently used languages first.
export function CodeLanguagePicker({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (language: string) => void;
}) {
  const t = useT();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0),
    [recents, setRecents] = useState<string[]>([]),
    [place, setPlace] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const current = canonicalLanguage(value) || "plaintext";
  const imported = !isKnownLanguage(value);
  const all = useMemo(() => codeLanguages(), []);
  // Sections: recently used and all languages, or the hits of the search.
  const sections = useMemo(() => {
    if (query.trim()) return [{ title: "", items: searchLanguages(query, all) }];
    const recent = recents.map((r) => all.find((l) => l.id === r)).filter((l): l is CodeLanguage => !!l);
    return [
      ...(recent.length ? [{ title: t("Zuletzt verwendet", "Recently used"), items: recent }] : []),
      { title: t("Alle Sprachen", "All languages"), items: all },
    ];
  }, [query, recents, all, t]);
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const optionId = (index: number) => `${id}-option-${index}`;

  const position = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(300, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = window.innerHeight - rect.bottom;
    const up = below < 320 && rect.top > below;
    setPlace({ top: up ? rect.top - 4 : rect.bottom + 4, left, width, up });
  };
  const show = () => {
    if (disabled) return;
    setRecents(readRecentLanguages());
    setQuery("");
    setActive(0);
    position();
    setOpen(true);
  };
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus({ preventScroll: true });
  };
  const choose = (language: CodeLanguage | undefined) => {
    if (!language) return;
    close();
    if (language.id !== current || imported) onChange(language.id);
  };

  // The current language is the active one when the list opens.
  useLayoutEffect(() => {
    if (!open) return;
    const index = flat.findIndex((l) => l.id === current);
    setActive(query.trim() ? 0 : Math.max(0, index));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);
  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    const reposition = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) position();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(flat.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(flat.length - 1, a + (e.key === "PageDown" ? 8 : -8))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") close(false);
  };

  let index = -1;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="code-language-button"
        aria-label={`${t("Code-Sprache", "Code language")}: ${languageLabel(value)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span>
          {languageLabel(value)}
          {imported && ` (${t("importiert", "imported")})`}
        </span>
        <CaretDown size={12} aria-hidden="true" />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={panel}
            className={`code-language-panel${place.up ? " up" : ""}`}
            style={{ top: place.top, left: place.left, width: place.width }}
          >
            <input
              ref={input}
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={flat.length ? optionId(active) : undefined}
              aria-label={t("Sprache suchen", "Search languages")}
              placeholder={t("Sprache, Kürzel oder Endung …", "Language, alias or extension …")}
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={keyDown}
            />
            <div ref={list} id={`${id}-list`} role="listbox" aria-label={t("Sprachen", "Languages")} className="code-language-list">
              {sections.map((section) => (
                <div role="group" aria-label={section.title || undefined} key={section.title || "results"}>
                  {section.title && (
                    <div className="code-language-group" aria-hidden="true">
                      {section.title}
                    </div>
                  )}
                  {section.items.map((language) => {
                    const i = ++index;
                    const selected = language.id === current && !imported;
                    return (
                      <div
                        key={`${section.title}:${language.id}`}
                        id={optionId(i)}
                        role="option"
                        aria-selected={selected}
                        className={`code-language-option${i === active ? " active" : ""}${selected ? " selected" : ""}`}
                        onPointerDown={(e) => e.preventDefault()}
                        onPointerEnter={() => setActive(i)}
                        onClick={() => choose(language)}
                      >
                        <span>{language.name}</span>
                        {selected ? <Check size={14} aria-hidden="true" /> : <small aria-hidden="true">{language.id === "plaintext" ? "" : language.id}</small>}
                      </div>
                    );
                  })}
                </div>
              ))}
              {!flat.length && <p className="code-language-empty">{t("Keine Sprache gefunden.", "No language found.")}</p>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
