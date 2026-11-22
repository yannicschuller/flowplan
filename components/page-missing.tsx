"use client";
import { FileX } from "@phosphor-icons/react";
import { useT } from "./i18n";

// A page link that leads nowhere (components/workspace-app.tsx): the page was
// deleted, never existed or is not shared with this person. The API answers
// 404 or 403 – one empty state for both, without a retry: trying again does
// not bring the page back.
export function PageMissing({ status, onBack, onHome }: { status: number; onBack: () => void; onHome: () => void }) {
  const t = useT();
  return (
    <div className="empty-state page-missing" role="alert" data-status={status}>
      <FileX size={38} aria-hidden="true" />
      <h3>{t("Diese Seite gibt es nicht (mehr) – oder du hast keinen Zugriff", "This page doesn't exist (any more) – or you have no access")}</h3>
      <ul className="page-missing-reasons">
        <li>
          <strong>{t("Gelöscht?", "Deleted?")}</strong>{" "}
          {t("Im Papierkorb kannst du sie wiederherstellen.", "You can restore it from the trash.")}{" "}
          <a href="#trash">{t("Zum Papierkorb", "Open the trash")}</a>
        </li>
        <li>
          <strong>{t("Nicht freigegeben?", "Not shared?")}</strong>{" "}
          {t("Frag die Person, die dir den Link geschickt hat.", "Ask the person who sent you the link.")}
        </li>
      </ul>
      <div className="page-missing-actions">
        <button type="button" className="button primary" onClick={onHome}>
          {t("Zur Startseite", "Go to the start page")}
        </button>
        <button type="button" className="button" onClick={onBack}>
          {t("Zurück", "Back")}
        </button>
      </div>
    </div>
  );
}
