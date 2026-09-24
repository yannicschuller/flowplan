"use client";
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
    <Modal open wide title={`Änderungen seit ${label}`} onClose={onClose}>
      {others.length > 0 && (
        <label className="version-compare">
          Vergleichen mit
          <select
            aria-label="Vergleichen mit"
            value={against}
            onChange={(e) => setAgainst(e.target.value)}
          >
            <option value="">Aktueller Stand</option>
            {others.map((v) => (
              <option key={v.id} value={v.id}>
                Version vom {v.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {!result && !error && <p className="muted">Vergleich wird geladen …</p>}
      {result?.kind === "document" &&
        (result.changes === null ? (
          <p role="status">
            Zu viele Änderungen für eine Gegenüberstellung. Die Version lässt
            sich trotzdem wiederherstellen.
          </p>
        ) : !result.changes.some((c) => c.type !== "same") ? (
          <p role="status">Keine Textänderungen.</p>
        ) : (
          <div className="version-diff" aria-label="Textänderungen">
            <p className="muted">
              <del>Entfernt</del> · <ins>Hinzugefügt</ins> · unveränderte
              Absätze sind abgeblendet.
            </p>
            {result.changes.map((change, i) =>
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
        ))}
      {result?.kind === "database" && (
        <DatabaseSummary changes={result.changes} />
      )}
    </Modal>
  );
}
function DatabaseSummary({ changes }: { changes: DatabaseChanges }) {
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
          {items.length > 50 && <li>… und {items.length - 50} weitere</li>}
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
    <div className="version-diff database" aria-label="Datenbankänderungen">
      {empty && <p role="status">Keine Änderungen seit dieser Version.</p>}
      {list("Neue Eigenschaften", changes.fields.added)}
      {list("Entfernte Eigenschaften", changes.fields.removed)}
      {list("Umbenannte Eigenschaften", changes.fields.renamed)}
      {list("Neue Einträge", changes.rows.added)}
      {list("Entfernte Einträge", changes.rows.removed)}
      {list(
        "Geänderte Einträge",
        changes.rows.changed.map((c) => `${c.title}: ${c.fields.join(", ")}`),
      )}
    </div>
  );
}
