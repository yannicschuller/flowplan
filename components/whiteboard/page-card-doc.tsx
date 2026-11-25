"use client";
// The whole document on a large page card of the board (#549): the app's
// read-only renderer (components/read-only-document.tsx – the one of the
// database feed, publications and templates) over the sanitized HTML of
// /api/pages/<id>/preview?full=1, kept and refreshed by card-preview.tsx.
// Loaded with the first large card (render.tsx), not with every board.
// Pictures are the workspace's files (/api/files/<id>, with the session).
import { LockSimple } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { ReadOnlyDocument } from "../read-only-document";
import { useCardDocument } from "./card-preview";

export default function PageCardDocument({ pageId }: { pageId: string }) {
  const t = useT();
  const doc = useCardDocument(pageId);
  if (doc.state === "loading") return <span className="wb-pagecard-note">{t("Wird geladen …", "Loading …")}</span>;
  if (doc.state === "encrypted" || doc.state === "locked" || doc.state === "denied")
    return (
      <span className="wb-pagecard-note">
        <LockSimple size={14} aria-hidden="true" />
        {doc.state === "encrypted"
          ? t("Verschlüsselt – öffne die Seite, um sie zu lesen.", "Encrypted – open the page to read it.")
          : doc.state === "locked"
            ? t("Gesperrt – öffne die Seite, um sie zu lesen.", "Locked – open the page to read it.")
            : t("Kein Zugriff auf den Inhalt.", "No access to the content.")}
      </span>
    );
  if (!doc.html) return <span className="wb-pagecard-note">{t("Diese Seite ist noch leer.", "This page is still empty.")}</span>;
  return <ReadOnlyDocument html={doc.html} pageId={pageId} className="wb-pagecard-doc" />;
}
