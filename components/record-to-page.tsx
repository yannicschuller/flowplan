"use client";
// "Turn into page": a record becomes a document page at a chosen place.
// Like "Move into database …" the dialog says first what changes: what
// comes along, the properties (kept as a list at the top, or dropped),
// access set on the record that ends, and relations to it.
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { Select } from "./select";
import { api, Modal } from "./ui";

type Target = { spaceId: string; parentId: string | null; title: string; space: string };
type Plan = {
  title: string;
  properties: { name: string; text: string }[];
  comments: number;
  versions: number;
  restricted: boolean;
  relations: number;
  targets: Target[];
  target: { spaceId: string; parentId: string | null } | null;
};
const keyOf = (t: { spaceId: string; parentId: string | null }) => `${t.spaceId}:${t.parentId || ""}`;

export function RecordToPage({
  pageId,
  rowId,
  onClose,
  onMoved,
  onError,
}: {
  pageId: string;
  rowId: string;
  onClose: () => void;
  onMoved: (pageId: string) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [target, setTarget] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Plan>(`/api/pages/${pageId}/rows/${rowId}/to-page`)
      .then((p) => {
        setPlan(p);
        setTarget(p.target ? keyOf(p.target) : "");
      })
      .catch((e) => {
        onError((e as Error).message);
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, rowId]);
  const chosen = plan?.targets.find((x) => keyOf(x) === target);
  const title = plan?.title || t("Ohne Titel", "Untitled");
  return (
    <Modal open onClose={onClose} title={t("In Seite umwandeln", "Turn into page")}>
      {!plan ? (
        <p className="muted">{t("Wird geladen …", "Loading …")}</p>
      ) : !plan.targets.length ? (
        <p className="muted">{t("Es gibt keinen Ort, an dem du Seiten anlegen darfst.", "There is no place where you may create pages.")}</p>
      ) : (
        <form
          className="page-to-record"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!chosen) return;
            setBusy(true);
            try {
              const r = await api<{ id: string }>("/api/command", {
                action: "record.toPage",
                pageId,
                rowId,
                spaceId: chosen.spaceId,
                parentId: chosen.parentId,
                keepProperties: keep,
              });
              onMoved(r.id);
            } catch (error) {
              onError((error as Error).message);
              setBusy(false);
            }
          }}
        >
          <p>
            {t(
              `„${title}“ wird eine Seite – mit Titel, Symbol, Titelbild, Inhalt, Dateien, ${plan.comments} Kommentar(en) und ${plan.versions} Version(en). Links auf den Eintrag zeigen danach auf die Seite.`,
              `“${title}” becomes a page – with its title, icon, cover, content, files, ${plan.comments} comment(s) and ${plan.versions} version(s). Links to the record then point to the page.`,
            )}
          </p>
          <label>
            {t("Ort", "Location")}
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              {plan.targets.map((x) => (
                <option key={keyOf(x)} value={keyOf(x)}>
                  {x.parentId ? x.title || t("Ohne Titel", "Untitled") : t(`${x.title} (oberste Ebene)`, `${x.title} (top level)`)}
                  {x.space ? ` · ${x.space}` : ""}
                </option>
              ))}
            </Select>
          </label>
          {plan.properties.length > 0 && (
            <>
              <label className="checkbox-label">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                {t("Eigenschaften als Liste oben auf der Seite behalten", "Keep the properties as a list at the top of the page")}
              </label>
              <ul className={`record-to-page-properties${keep ? "" : " dropped"}`}>
                {plan.properties.slice(0, 12).map((p, i) => (
                  <li key={i}>
                    <strong>{p.name}:</strong> {p.text}
                  </li>
                ))}
                {plan.properties.length > 12 && <li className="muted">{t(`und ${plan.properties.length - 12} weitere`, `and ${plan.properties.length - 12} more`)}</li>}
              </ul>
            </>
          )}
          {(plan.restricted || plan.relations > 0) && (
            <div className="page-to-record-ends" role="note">
              <strong>{t("Das endet:", "This ends:")}</strong>{" "}
              {[
                plan.restricted ? t("die eigenen Rechte des Eintrags", "the record's own permissions") : "",
                plan.relations ? t(`Relationen von ${plan.relations} Eintrag/Einträgen auf diesen Eintrag`, `relations from ${plan.relations} record(s) to this record`) : "",
              ]
                .filter(Boolean)
                .join(", ")}
              .
            </div>
          )}
          <p className="muted small">
            {t(
              "Die Seite folgt den Rechten ihres Orts. Der Eintrag selbst kommt in den Papierkorb.",
              "The page follows the permissions of its location. The record itself goes to the trash.",
            )}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary" disabled={busy || !chosen}>
              {busy ? t("Wird umgewandelt …", "Turning into page …") : t("Umwandeln", "Turn into page")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
