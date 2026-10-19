"use client";
// "Move into database…": the page becomes a record of a chosen database.
// The dialog says first what changes: sharing that ends, sub-pages that
// move up, and what comes along (content, files, comments, versions).
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { Select } from "./select";
import { api, Modal } from "./ui";

type Plan = {
  title: string;
  subpages: number;
  grants: number;
  shareLinks: number;
  published: boolean;
  comments: number;
  versions: number;
  databases: { id: string; title: string; space: string }[];
};

export function PageToRecord({
  pageId,
  onClose,
  onMoved,
  onError,
}: {
  pageId: string;
  onClose: () => void;
  onMoved: (pageId: string, rowId: string) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Plan>(`/api/pages/${pageId}/to-record`)
      .then((p) => {
        setPlan(p);
        setTarget(p.databases[0]?.id || "");
      })
      .catch((e) => {
        onError((e as Error).message);
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  const ends = plan
    ? [
        plan.grants ? t(`${plan.grants} Seitenfreigabe(n) für Personen`, `${plan.grants} page permission(s) for people`) : "",
        plan.shareLinks ? t(`${plan.shareLinks} Freigabelink(s)`, `${plan.shareLinks} share link(s)`) : "",
        plan.published ? t("die Veröffentlichung im Web", "the publication on the web") : "",
      ].filter(Boolean)
    : [];
  return (
    <Modal open onClose={onClose} title={t("In Datenbank verschieben", "Move into database")}>
      {!plan ? (
        <p className="muted">{t("Wird geladen …", "Loading …")}</p>
      ) : !plan.databases.length ? (
        <p className="muted">{t("Es gibt keine Datenbank, in die du schreiben darfst.", "There is no database you may write to.")}</p>
      ) : (
        <form
          className="page-to-record"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api<{ id: string; rowId: string }>("/api/command", { action: "page.toRecord", pageId, databaseId: target });
              onMoved(r.id, r.rowId);
            } catch (error) {
              onError((error as Error).message);
              setBusy(false);
            }
          }}
        >
          <p>
            {t(
              `„${plan.title}“ wird ein Eintrag der gewählten Datenbank – mit Inhalt, Dateien, Kommentaren und ${plan.versions} Version(en). Links auf die Seite zeigen danach auf den Eintrag, die Standardvorlage der Datenbank wird übernommen.`,
              `“${plan.title}” becomes a record of the chosen database – with its content, files, comments and ${plan.versions} version(s). Links to the page then point to the record, and the database's default record template applies.`,
            )}
          </p>
          <label>
            {t("Datenbank", "Database")}
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              {plan.databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || t("Ohne Titel", "Untitled")}
                  {d.space ? ` · ${d.space}` : ""}
                </option>
              ))}
            </Select>
          </label>
          {plan.subpages > 0 && (
            <p className="muted small">
              {t(
                `${plan.subpages} Unterseite(n) bleiben Seiten und rücken eine Ebene nach oben.`,
                `${plan.subpages} sub-page(s) stay pages and move up one level.`,
              )}
            </p>
          )}
          {ends.length > 0 && (
            <div className="page-to-record-ends" role="note">
              <strong>{t("Das endet:", "This ends:")}</strong> {ends.join(", ")}.{" "}
              {t("Der Eintrag folgt den Rechten der Datenbank.", "The record follows the database's permissions.")}
            </div>
          )}
          <p className="muted small">{t("Die Seite selbst kommt in den Papierkorb.", "The page itself goes to the trash.")}</p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary" disabled={busy || !target}>
              {busy ? t("Wird verschoben …", "Moving …") : t("Verschieben", "Move")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
