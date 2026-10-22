"use client";
// Presentation mode of a document (page menu "Präsentieren"): full screen,
// one slide per H1 (or H2, or between horizontal rules – lib/slides.ts),
// rendered read-only like a published page. Arrow keys, space, Page Up/Down,
// Home/End and clicks move; Escape ends. A note callout at the end of a
// slide holds speaker notes, shown in the presenter view – a second window
// (app/presenter) kept in step over a BroadcastChannel. The slides print as
// one landscape page each through the usual print path.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CornersOut, Moon, Notepad, Printer, Sun, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { ReadOnlyDocument } from "./read-only-document";
import { printPage } from "./print-page";
import { planSlides } from "@/lib/slides";
import { applyTheme } from "@/lib/theme";

export type Slide = { html: string; notes: string };
export type Deck = { title: string; slides: Slide[] };

// Messages between the presentation and the presenter view.
export type PresenterMessage =
  | { type: "hello" }
  | { type: "deck"; deck: Deck; index: number; startedAt: number }
  | { type: "index"; index: number }
  | { type: "go"; index: number }
  | { type: "end" };
export const presenterChannel = (id: string) => `flowplan-presenter-${id}`;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The document's HTML as slides (in the browser: needs DOMParser).
export function buildDeck(html: string, title: string): Deck {
  const body = new DOMParser().parseFromString(html || "", "text/html").body;
  const elements = [...body.children] as HTMLElement[];
  const blocks = elements.map((el) => ({
    tag: el.tagName,
    callout: el.getAttribute("data-callout"),
    empty: el.tagName === "P" && !el.textContent?.trim() && !el.querySelector("img, video, iframe, [data-math], [data-mermaid]"),
  }));
  const slides = planSlides(blocks).map((plan) => ({
    html: plan.blocks.map((i) => elements[i].outerHTML).join(""),
    notes: plan.notes === null ? "" : elements[plan.notes].innerHTML,
  }));
  // A first slide without a heading of its own gets the page title.
  const first = slides[0];
  const heading = `<h1>${escapeHtml(title)}</h1>`;
  if (!first) slides.push({ html: heading, notes: "" });
  else if (!/^<h[12][\s>]/i.test(first.html)) first.html = heading + first.html;
  return { title, slides };
}

// The slide scaled down until it fits the stage.
export function FittedSlide({ html, animate }: { html: string; animate: boolean }) {
  const stage = useRef<HTMLDivElement>(null),
    slide = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const outer = stage.current,
      inner = slide.current;
    if (!outer || !inner) return;
    const fit = () => {
      const width = inner.offsetWidth,
        height = inner.offsetHeight;
      if (!width || !height) return;
      setScale(Math.min(1.6, (outer.clientWidth * 0.94) / width, (outer.clientHeight * 0.92) / height));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [html]);
  return (
    <div className="presentation-stage" ref={stage}>
      <div
        className={`presentation-slide${animate ? " animate" : ""}`}
        ref={slide}
        style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <ReadOnlyDocument html={html} className="presentation-document" />
      </div>
    </div>
  );
}

export function Presentation({ html, title, onClose }: { html: string; title: string; onClose: () => void }) {
  const t = useT();
  const deck = useMemo(() => buildDeck(html, title), [html, title]);
  const count = deck.slides.length;
  const [index, setIndex] = useState(0),
    [dark, setDark] = useState(() => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"),
    [printing, setPrinting] = useState(false),
    [presenter, setPresenter] = useState(false),
    // The controls show while the pointer moves and fade after a while.
    [idle, setIdle] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    printRoot = useRef<HTMLDivElement>(null),
    channel = useRef<BroadcastChannel | null>(null),
    deckId = useRef(""),
    startedAt = useRef(Date.now()),
    indexRef = useRef(0),
    closeRef = useRef(onClose);
  indexRef.current = index;
  closeRef.current = onClose;
  const go = useCallback(
    (to: number) => setIndex(Math.max(0, Math.min(count - 1, to))),
    [count],
  );
  // Full screen while the browser allows it; leaving it ends the presentation.
  useEffect(() => {
    const el = root.current;
    let entered = false;
    const change = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) closeRef.current();
    };
    document.addEventListener("fullscreenchange", change);
    el?.requestFullscreen?.().catch(() => {});
    el?.focus();
    return () => {
      document.removeEventListener("fullscreenchange", change);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  // The look of the slides: the page's colours change along, and come back.
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => () => void applyTheme(), []);
  // Keys win over the app's own shortcuts while presenting.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const at = indexRef.current;
      const step: Record<string, number> = {
        ArrowRight: at + 1,
        ArrowDown: at + 1,
        PageDown: at + 1,
        " ": e.shiftKey ? at - 1 : at + 1,
        Enter: at + 1,
        ArrowLeft: at - 1,
        ArrowUp: at - 1,
        PageUp: at - 1,
        Backspace: at - 1,
        Home: 0,
        End: count - 1,
      };
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (!(e.key in step)) return;
      // Buttons of the controls keep Enter and Space.
      if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement | null)?.closest?.("button, a")) return;
      e.preventDefault();
      e.stopPropagation();
      go(step[e.key]);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [count, go]);
  // The presenter view: answers its hello with the slides, follows its steps.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    deckId.current = crypto.randomUUID();
    const bc = new BroadcastChannel(presenterChannel(deckId.current));
    channel.current = bc;
    bc.onmessage = (event: MessageEvent<PresenterMessage>) => {
      const message = event.data;
      if (message?.type === "hello") {
        setPresenter(true);
        bc.postMessage({ type: "deck", deck, index: indexRef.current, startedAt: startedAt.current } satisfies PresenterMessage);
      } else if (message?.type === "go" && Number.isInteger(message.index)) go(message.index);
      else if (message?.type === "end") setPresenter(false);
    };
    return () => {
      bc.postMessage({ type: "end" } satisfies PresenterMessage);
      bc.close();
      channel.current = null;
    };
  }, [deck, go]);
  useEffect(() => {
    channel.current?.postMessage({ type: "index", index } satisfies PresenterMessage);
  }, [index]);
  useEffect(() => {
    if (idle) return;
    const timer = setTimeout(() => setIdle(true), 2500);
    return () => clearTimeout(timer);
  }, [idle, index]);
  // Printing: all slides once, then the print path with the copy.
  useEffect(() => {
    if (!printing) return;
    const timer = setTimeout(() => {
      if (printRoot.current) printPage(printRoot.current);
      setTimeout(() => setPrinting(false), 1500);
    }, 900);
    return () => clearTimeout(timer);
  }, [printing]);
  const openPresenter = () => {
    const url = `/presenter?deck=${encodeURIComponent(deckId.current)}`;
    const view = window.open(url, "flowplan-presenter", "popup,width=1100,height=720");
    if (!view) location.assign(url);
  };
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const slide = deck.slides[index];
  const interactive = (target: EventTarget | null) =>
    !!(target as HTMLElement | null)?.closest?.("a, button, input, textarea, select, summary, video, audio, iframe, details, .presentation-controls");
  return (
    <div
      ref={root}
      className={`presentation${idle ? " idle" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-roledescription={t("Präsentation", "Presentation")}
      aria-label={title}
      tabIndex={-1}
      onPointerMove={() => idle && setIdle(false)}
    >
      <div className="presentation-progress" aria-hidden="true">
        <span style={{ width: `${((index + 1) / count) * 100}%` }} />
      </div>
      <div
        className="presentation-body"
        onClick={(e) => {
          if (interactive(e.target) || window.getSelection()?.toString()) return;
          const rect = e.currentTarget.getBoundingClientRect();
          go(e.clientX - rect.left < rect.width / 3 ? index - 1 : index + 1);
        }}
        aria-live="polite"
      >
        <FittedSlide key={index} html={slide.html} animate={!reducedMotion} />
      </div>
      <div className="presentation-controls" role="toolbar" aria-label={t("Präsentation steuern", "Control the presentation")}>
        <button type="button" className="icon-button" onClick={() => go(index - 1)} disabled={index === 0} aria-label={t("Vorherige Folie", "Previous slide")}>
          <ArrowLeft size={18} />
        </button>
        <span className="presentation-counter" aria-live="polite">
          {t(`Folie ${index + 1} von ${count}`, `Slide ${index + 1} of ${count}`)}
        </span>
        <button type="button" className="icon-button" onClick={() => go(index + 1)} disabled={index === count - 1} aria-label={t("Nächste Folie", "Next slide")}>
          <ArrowRight size={18} />
        </button>
        <span className="presentation-separator" aria-hidden="true" />
        <button type="button" className={`icon-button${presenter ? " active" : ""}`} onClick={openPresenter} title={t("Referentenansicht", "Presenter view")} aria-label={t("Referentenansicht", "Presenter view")}>
          <Notepad size={18} />
        </button>
        <button type="button" className="icon-button" onClick={() => setDark((v) => !v)} aria-label={dark ? t("Helle Folien", "Light slides") : t("Dunkle Folien", "Dark slides")} title={dark ? t("Helle Folien", "Light slides") : t("Dunkle Folien", "Dark slides")}>
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button type="button" className="icon-button" onClick={() => setPrinting(true)} disabled={printing} aria-label={t("Folien drucken oder als PDF sichern", "Print slides or save as PDF")} title={t("Folien drucken / PDF", "Print slides / PDF")}>
          <Printer size={18} />
        </button>
        <button type="button" className="icon-button" onClick={() => root.current?.requestFullscreen?.().catch(() => {})} aria-label={t("Vollbild", "Full screen")} title={t("Vollbild", "Full screen")}>
          <CornersOut size={18} />
        </button>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("Präsentation beenden (Esc)", "End presentation (Esc)")} title={t("Präsentation beenden (Esc)", "End presentation (Esc)")}>
          <X size={18} />
        </button>
      </div>
      {printing && (
        <div className="presentation-print" ref={printRoot} aria-hidden="true">
          <style>{"@page { size: landscape; margin: 14mm; }"}</style>
          {deck.slides.map((s, i) => (
            <section className="presentation-print-slide" key={i}>
              <ReadOnlyDocument html={s.html} className="presentation-document" />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
