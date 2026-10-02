"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { List, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { DocGroup, DocSearchEntry } from "@/lib/docs";
import { useT } from "../i18n";
import s from "./docs.module.css";

// Sidebar of the documentation; on small screens it folds into a menu.
export function DocsNav({ groups }: { groups: DocGroup[] }) {
  const t = useT();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const current = groups.flatMap((g) => g.pages).find((p) => path === `/docs/${p.slug}`);
  return (
    <nav className={s.nav} aria-label={t("Dokumentation", "Documentation")} data-open={open}>
      <button
        type="button"
        className={s.navToggle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <X size={18} /> : <List size={18} />}
        <span>{current?.title || t("Übersicht", "Overview")}</span>
      </button>
      <div className={s.navList}>
        <a href="/docs" aria-current={path === "/docs" ? "page" : undefined}>
          {t("Übersicht", "Overview")}
        </a>
        {groups.map((group) => (
          <div key={group.title} className={s.navGroup}>
            <p>{group.title}</p>
            {group.pages.map((page) => (
              <a
                key={page.slug}
                href={`/docs/${page.slug}`}
                aria-current={path === `/docs/${page.slug}` ? "page" : undefined}
              >
                {page.title}
              </a>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss");

// Search over page titles, summaries and section headings. "/" focuses it.
export function DocsSearch({ index }: { index: DocSearchEntry[] }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || target.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const results = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hits: { href: string; title: string; context: string; snippet?: string; score: number }[] = [];
    const all = (text: string) => words.every((w) => text.includes(w));
    // A short excerpt around the first matching word.
    const excerpt = (text: string) => {
      const at = fold(text).indexOf(words[0]);
      if (at < 0) return undefined;
      const start = Math.max(0, text.lastIndexOf(" ", Math.max(0, at - 40)) + 1);
      return (start > 0 ? "… " : "") + text.slice(start, start + 110).trim() + (start + 110 < text.length ? " …" : "");
    };
    for (const page of index) {
      if (all(fold(`${page.title} ${page.summary}`)))
        hits.push({
          href: `/docs/${page.slug}`,
          title: page.title,
          context: page.group,
          score: all(fold(page.title)) ? 0 : 2,
        });
      else if (all(fold(page.text)))
        hits.push({
          href: `/docs/${page.slug}`,
          title: page.title,
          context: page.group,
          snippet: excerpt(page.text),
          score: 4,
        });
      for (const section of page.sections) {
        const heading = fold(`${section.text} ${page.title}`);
        if (all(heading))
          hits.push({
            href: `/docs/${page.slug}#${section.id}`,
            title: section.text,
            context: page.title,
            score: all(fold(section.text)) ? 1 : 3,
          });
        else if (all(fold(`${section.text} ${section.body}`)))
          hits.push({
            href: `/docs/${page.slug}#${section.id}`,
            title: section.text,
            context: page.title,
            snippet: excerpt(section.body),
            score: 5,
          });
      }
    }
    return hits.sort((a, b) => a.score - b.score).slice(0, 10);
  }, [index, query]);
  return (
    <div className={s.search}>
      <MagnifyingGlass size={16} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        placeholder={t("Doku durchsuchen", "Search docs")}
        aria-label={t("Dokumentation durchsuchen", "Search the documentation")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + step + results.length) % Math.max(results.length, 1));
          } else if (e.key === "Enter" && results[active]) {
            location.assign(results[active].href);
            setQuery("");
          } else if (e.key === "Escape") setQuery("");
        }}
      />
      <kbd>/</kbd>
      {query.trim() && (
        <ul className={s.results} role="listbox" aria-label="Treffer">
          {results.length ? (
            results.map((hit, i) => (
              <li key={hit.href} role="option" aria-selected={i === active}>
                <a href={hit.href} onClick={() => setQuery("")} onMouseEnter={() => setActive(i)}>
                  <strong>{hit.title}</strong>
                  <small>{hit.context}</small>
                  {hit.snippet && <span>{hit.snippet}</span>}
                </a>
              </li>
            ))
          ) : (
            <li className={s.noHits}>{t("Nichts gefunden.", "Nothing found.")}</li>
          )}
        </ul>
      )}
    </div>
  );
}
