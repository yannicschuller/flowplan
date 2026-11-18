"use client";
// "14 Wertungen warten auf Verbindung" (docs/specs/flashcards.md §10.4):
// flashcard ratings made offline that wait on this device
// (components/study/offline.ts), in the style of the record queue's note.
import { CloudSlash } from "@phosphor-icons/react";
import { useT } from "../i18n";

export function StudyPendingNote({ count, className = "" }: { count: number; className?: string }) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <p className={`offline-pending study-pending ${className}`.trim()} role="status">
      <CloudSlash aria-hidden />{" "}
      {count === 1 ? t("1 Wertung wartet auf Verbindung", "1 rating is waiting for the connection") : t(`${count} Wertungen warten auf Verbindung`, `${count} ratings are waiting for the connection`)}
    </p>
  );
}
