"use client";
// The presenter view of a presentation (components/presentation.tsx), in a
// window of its own: the current slide, the next one, the speaker notes and
// the time. Everything arrives over the BroadcastChannel of the presentation
// in the other window (same origin only); steps taken here go back to it.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Timer } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { ReadOnlyDocument } from "./read-only-document";
import { FittedSlide, presenterChannel, type Deck, type PresenterMessage } from "./presentation";

export function PresenterView({ deckId }: { deckId: string }) {
  const t = useT();
  const [deck, setDeck] = useState<Deck | null>(null),
    [index, setIndex] = useState(0),
    [ended, setEnded] = useState(false),
    [startedAt, setStartedAt] = useState(0),
    [now, setNow] = useState(0);
  const channel = useRef<BroadcastChannel | null>(null),
    indexRef = useRef(0),
    countRef = useRef(0);
  indexRef.current = index;
  countRef.current = deck?.slides.length || 0;
  useEffect(() => {
    if (!deckId || typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(presenterChannel(deckId));
    channel.current = bc;
    bc.onmessage = (event: MessageEvent<PresenterMessage>) => {
      const message = event.data;
      if (message?.type === "deck") {
        setDeck(message.deck);
        setIndex(message.index);
        setStartedAt(message.startedAt);
        setEnded(false);
      } else if (message?.type === "index") setIndex(message.index);
      else if (message?.type === "end") setEnded(true);
    };
    bc.postMessage({ type: "hello" } satisfies PresenterMessage);
    const bye = () => bc.postMessage({ type: "end" } satisfies PresenterMessage);
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      bc.close();
      channel.current = null;
    };
  }, [deckId]);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const go = (to: number) => {
    const next = Math.max(0, Math.min(countRef.current - 1, to));
    setIndex(next);
    channel.current?.postMessage({ type: "go", index: next } satisfies PresenterMessage);
  };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const at = indexRef.current;
      const step: Record<string, number> = {
        ArrowRight: at + 1,
        ArrowDown: at + 1,
        PageDown: at + 1,
        " ": e.shiftKey ? at - 1 : at + 1,
        ArrowLeft: at - 1,
        ArrowUp: at - 1,
        PageUp: at - 1,
        Home: 0,
        End: countRef.current - 1,
      };
      if (!(e.key in step) || (e.key === " " && (e.target as HTMLElement | null)?.closest?.("button"))) return;
      e.preventDefault();
      goRef.current(step[e.key]);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const elapsed = startedAt && now ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  if (!deck)
    return (
      <main className="presenter-view presenter-waiting">
        <p role="status">
          {deckId
            ? t("Warte auf die Präsentation … Öffne die Referentenansicht aus einer laufenden Präsentation.", "Waiting for the presentation … Open the presenter view from a running presentation.")
            : t("Keine Präsentation angegeben.", "No presentation given.")}
        </p>
      </main>
    );
  const slide = deck.slides[index],
    next = deck.slides[index + 1];
  return (
    <main className="presenter-view">
      <header className="presenter-header">
        <h1>{deck.title}</h1>
        <span className="presenter-time" aria-label={t("Verstrichene Zeit", "Elapsed time")}>
          <Timer size={16} aria-hidden="true" />
          {clock}
        </span>
        <span className="presenter-counter" aria-live="polite">
          {t(`Folie ${index + 1} von ${deck.slides.length}`, `Slide ${index + 1} of ${deck.slides.length}`)}
        </span>
        <span className="presenter-nav">
          <button type="button" className="button compact" onClick={() => go(index - 1)} disabled={index === 0}>
            <ArrowLeft size={16} />
            {t("Zurück", "Back")}
          </button>
          <button type="button" className="button primary compact" onClick={() => go(index + 1)} disabled={index >= deck.slides.length - 1}>
            {t("Weiter", "Next")}
            <ArrowRight size={16} />
          </button>
        </span>
      </header>
      {ended && (
        <p className="presenter-ended" role="status">
          {t("Die Präsentation wurde beendet.", "The presentation has ended.")}
        </p>
      )}
      <section className="presenter-current" aria-label={t("Aktuelle Folie", "Current slide")}>
        {slide && <FittedSlide key={`now-${index}`} html={slide.html} animate={false} />}
      </section>
      <section className="presenter-next" aria-label={t("Nächste Folie", "Next slide")}>
        <h2>{t("Als Nächstes", "Up next")}</h2>
        {next ? <FittedSlide key={`next-${index}`} html={next.html} animate={false} /> : <p className="muted">{t("Ende der Präsentation", "End of the presentation")}</p>}
      </section>
      <section className="presenter-notes" aria-label={t("Notizen", "Notes")}>
        <h2>{t("Notizen", "Notes")}</h2>
        {slide?.notes ? (
          <ReadOnlyDocument key={`notes-${index}`} html={slide.notes} className="presenter-notes-text" />
        ) : (
          <p className="muted">
            {t("Keine Notizen für diese Folie. Notizen stehen in einem Hinweis-Callout am Ende der Folie.", "No notes for this slide. Notes go into a note callout at the end of the slide.")}
          </p>
        )}
      </section>
    </main>
  );
}
