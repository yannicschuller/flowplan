"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useState } from "react";
import { Modal, api } from "./ui";
import type { TextChange } from "@/lib/text-diff";
import type { DatabaseChanges } from "@/lib/version-history";

type Result =
  | { kind: "document"; changes: TextChange[] | null }
  | { kind: "database"; changes: DatabaseChanges };

// Shows what changed between a saved version and the current page.
export function VersionChanges({
  pageId,
  rowId,
  snapshotId,
  label,
  versions = [],
  onClose,
}: {
  pageId: string;
  rowId?: string;
  snapshotId: string;
  label: string;
  // Other versions to compare with; empty compares with the current state.
  versions?: { id: string; label: string }[];
  onClose: () => void;
}) {
  const t = useT();
  const [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState(""),
    [against, setAgainst] = useState("");
  useEffect(() => {
    let active = true;
    setResult(null);
    setError("");
    const base = rowId
      ? `/api/pages/${pageId}/rows/${rowId}/snapshots/${snapshotId}/changes`
      : `/api/pages/${pageId}/snapshots/${snapshotId}/changes`;
    api<Result>(`${base}${against ? `?against=${against}` : ""}`)
      .then((r) => active && setResult(r))
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [pageId, rowId, snapshotId, against]);
  const others = versions.filter((v) => v.id !== snapshotId);
  return (
    <Modal open wide title={t(`Änderungen seit ${label}`, `Changes since ${label}`)} onClose={onClose}>
      {others.length > 0 && (
        <label className="version-compare">
          {t("Vergleichen mit", "Compare with")}
          <Select
            aria-label={t("Vergleichen mit", "Compare with")}
            value={against}
            onChange={(e) => setAgainst(e.target.value)}
          >
            <option value="">{t("Aktueller Stand", "Current state")}</option>
            {others.map((v) => (
              <option key={v.id} value={v.id}>
                {t("Version vom", "Version of")}{" "}{v.label}
              </option>
            ))}
          </Select>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {!result && !error && <p className="muted">{t("Vergleich wird geladen …", "Loading comparison …")}</p>}
      {result?.kind === "document" &&
        (result.changes === null ? (
          <p role="status">
            {t("Zu viele Änderungen für eine Gegenüberstellung. Die Version lässt sich trotzdem wiederherstellen.", "Too many changes to compare. The version can still be restored.")}
          </p>
        ) : !result.changes.some((c) => c.type !== "same") ? (
          <p role="status">{t("Keine Textänderungen.", "No text changes.")}</p>
        ) : (
          <TextChanges changes={result.changes} />
        ))}
      {result?.kind === "database" && (
        <DatabaseSummary changes={result.changes} />
      )}
    </Modal>
  );
}
function DatabaseSummary({ changes }: { changes: DatabaseChanges }) {
  const t = useT();
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <section>
        <h3>
          {title} ({items.length})
        </h3>
        <ul>
          {items.slice(0, 50).map((item, i) => (
            <li key={i}>{item}</li>
          ))}
          {items.length > 50 && <li>{t("… und", "… and")}{" "}{items.length - 50} weitere</li>}
        </ul>
      </section>
    );
  const empty =
    !changes.fields.added.length &&
    !changes.fields.removed.length &&
    !changes.fields.renamed.length &&
    !changes.rows.added.length &&
    !changes.rows.removed.length &&
    !changes.rows.changed.length;
  return (
    <div className="version-diff database" aria-label={t("Datenbankänderungen", "Database changes")}>
      {empty && <p role="status">{t("Keine Änderungen seit dieser Version.", "No changes since this version.")}</p>}
      {list(t("Neue Eigenschaften", "New properties"), changes.fields.added)}
      {list(t("Entfernte Eigenschaften", "Removed properties"), changes.fields.removed)}
      {list(t("Umbenannte Eigenschaften", "Renamed properties"), changes.fields.renamed)}
      {list(t("Neue Einträge", "New records"), changes.rows.added)}
      {list(t("Entfernte Einträge", "Removed records"), changes.rows.removed)}
      {list(
        t("Geänderte Einträge", "Changed records"),
        changes.rows.changed.map((c) => `${c.title}: ${c.fields.join(", ")}`),
      )}
    </div>
  );
}

// Paragraph and word changes, as in the version history.
export function TextChanges({ changes }: { changes: TextChange[] }) {
  const t = useT();
  return (
          <div className="version-diff" aria-label={t("Textänderungen", "Text changes")}>
            <p className="muted">
              <del>{t("Entfernt", "Removed")}</del> · <ins>{t("Hinzugefügt", "Added")}</ins> {t("· unveränderte Absätze sind abgeblendet.", "· unchanged paragraphs are dimmed.")}
            </p>
            {changes.map((change, i) =>
              change.type === "changed" ? (
                <p key={i} className="diff-changed">
                  {change.parts.map((part, j) =>
                    part.type === "added" ? (
                      <ins key={j}>{part.text}</ins>
                    ) : part.type === "removed" ? (
                      <del key={j}>{part.text}</del>
                    ) : (
                      <span key={j}>{part.text}</span>
                    ),
                  )}
                </p>
              ) : change.type === "added" ? (
                <p key={i} className="diff-added">
                  <ins>{change.text}</ins>
                </p>
              ) : change.type === "removed" ? (
                <p key={i} className="diff-removed">
                  <del>{change.text}</del>
                </p>
              ) : (
                <p key={i} className="diff-same">
                  {change.text}
                </p>
              ),
            )}
          </div>
  );
}
