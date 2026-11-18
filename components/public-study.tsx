"use client";
// The study view of a shared or published deck (docs/specs/flashcards.md
// §7.3): "Durchblättern" – the cards as a grid, rendered on the server; a
// click (or "Umdrehen") turns a card – and "Üben", the focus mode without an
// account (./study/public-practice.tsx, loaded when started). The practice
// keeps its state in this browser only; "Fortschritt löschen" removes it.
// A signed-in member of the workspace gets "In Flowplan lernen" instead of
// a state in the browser.
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ArrowsClockwise, Cards, GraduationCap } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Side } from "./study/card-parts";
import { OcclusionImage } from "./study/occlusion-image";
import { hasProgress, progressKey } from "@/lib/public-study-key";
import type { PublicStudyCard } from "@/lib/shared-study";

const PublicPractice = dynamic(() => import("./study/public-practice"), { ssr: false });

function FlashCard({ card, pageId, token, index }: { card: PublicStudyCard; pageId: string; token: string; index: number }) {
  const t = useT();
  const [flipped, setFlipped] = useState(false);
  const turn = () => setFlipped((f) => !f);
  const side = (s: PublicStudyCard["front"]) => <Side side={s} pageId={pageId} shareToken={token} />;
  const answer = card.occlusion ? ("text" in card.back ? card.back.text : "") : "";
  return (
    <li>
      <article
        className={`public-flashcard${flipped ? " flipped" : ""}`}
        aria-label={t(`Karte ${index}`, `Card ${index}`)}
        onClick={(e) => {
          // Links and media in the card keep their clicks.
          if ((e.target as HTMLElement).closest("a, button, video, audio, input, summary")) return;
          turn();
        }}
      >
        {card.context && <div className="study-context">{side(card.context)}</div>}
        {card.occlusion ? (
          <OcclusionImage occlusion={card.occlusion} reveal={flipped} />
        ) : card.kind === "cloze" ? (
          side(flipped ? card.back : card.front)
        ) : (
          <div className="public-flashcard-front">{side(card.front)}</div>
        )}
        {!flipped && card.hint && <div className="public-flashcard-hint muted">{side(card.hint)}</div>}
        {flipped && (
          <div className="public-flashcard-back">
            {card.kind !== "cloze" && !card.occlusion && side(card.back)}
            {answer && <p className="study-text occlusion-answer">{answer}</p>}
            {card.note && <div className="study-extra">{side(card.note)}</div>}
            {card.extra && <div className="study-extra">{side(card.extra)}</div>}
          </div>
        )}
        <button type="button" className="text-button public-flashcard-turn" aria-pressed={flipped} onClick={turn}>
          <ArrowsClockwise aria-hidden size={14} /> {flipped ? t("Vorderseite", "Front") : t("Umdrehen", "Turn over")}
        </button>
      </article>
    </li>
  );
}

export function PublicStudy({
  token,
  pageId,
  viewId,
  title,
  cards,
  total,
  first,
  pages,
  memberHref,
}: {
  token: string;
  pageId: string;
  viewId?: string;
  title: string;
  cards: PublicStudyCard[];
  total: number;
  // The number of the first card shown, and links to the other parts.
  first: number;
  pages: { previous?: string; next?: string };
  // "In Flowplan lernen" for a signed-in member.
  memberHref?: string;
}) {
  const t = useT();
  const [practice, setPractice] = useState(false);
  const [stored, setStored] = useState(false);
  const [status, setStatus] = useState("");
  const read = () => {
    try {
      setStored(hasProgress(token, window.localStorage));
    } catch {
      setStored(false);
    }
  };
  useEffect(read, [token]);
  return (
    <section className="public-study" aria-label={t("Lernkarten", "Flashcards")}>
      <div className="public-study-bar">
        <div className="public-study-modes" role="group" aria-label={t("Lernen", "Study")}>
          <button type="button" className="button compact" aria-pressed={!practice}>
            <Cards aria-hidden size={16} /> {t("Durchblättern", "Browse")}
          </button>
          <button type="button" className="button compact primary" aria-pressed={practice} disabled={!total} onClick={() => setPractice(true)}>
            <GraduationCap aria-hidden size={16} /> {t("Üben", "Practise")}
          </button>
        </div>
        <span className="muted public-study-count">{total === 1 ? t("1 Karte", "1 card") : t(`${total} Karten`, `${total} cards`)}</span>
        {memberHref && (
          <a className="button compact" href={memberHref}>
            {t("In Flowplan lernen", "Study in Flowplan")}
          </a>
        )}
        {stored && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              try {
                window.localStorage.removeItem(progressKey(token));
              } catch {}
              read();
              setStatus(t("Fortschritt gelöscht.", "Progress deleted."));
            }}
          >
            {t("Fortschritt löschen", "Delete progress")}
          </button>
        )}
      </div>
      <p className="sr-only" role="status">
        {status}
      </p>
      {cards.length ? (
        <ol className="public-study-grid" start={first}>
          {cards.map((card, i) => (
            <FlashCard key={`${card.rowId}:${card.sub}`} card={card} pageId={pageId} token={token} index={first + i} />
          ))}
        </ol>
      ) : (
        <p className="muted">{t("Dieser Stapel hat noch keine Karten.", "This deck has no cards yet.")}</p>
      )}
      {(pages.previous || pages.next) && (
        <nav className="public-month public-study-pages" aria-label={t("Weitere Karten", "More cards")}>
          {pages.previous ? <a href={pages.previous}>← {t("Vorherige Karten", "Previous cards")}</a> : <span />}
          <span className="muted">{t(`Karten ${first}–${first + cards.length - 1} von ${total}`, `Cards ${first}–${first + cards.length - 1} of ${total}`)}</span>
          {pages.next ? <a href={pages.next}>{t("Nächste Karten", "Next cards")} →</a> : <span />}
        </nav>
      )}
      {practice && (
        <PublicPractice
          token={token}
          pageId={pageId}
          viewId={viewId}
          title={title}
          onClose={() => {
            setPractice(false);
            read();
          }}
          onCleared={() => setStatus(t("Fortschritt gelöscht.", "Progress deleted."))}
        />
      )}
    </section>
  );
}
