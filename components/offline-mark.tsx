"use client";
// Content made offline (#370): the small mark beside a page that is not on
// the server yet (sidebar, lists), and the note on such a page – waiting
// for the connection, or refused by the server with the reason and what
// the person can do (try again, copy the text, save a file, discard).
import { CloudArrowUp, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { useT } from "./i18n";
import { downloadBlob } from "./ui";
import { keptUpload } from "./offline-uploads";
import type { FailedChange } from "@/lib/offline-create";

export function OfflineMark({ state }: { state: "pending" | "failed" }) {
  const t = useT();
  const label =
    state === "failed"
      ? t("Nicht synchronisiert – der Server hat abgelehnt", "Not synced – the server refused")
      : t("Noch nicht synchronisiert", "Not yet synced");
  const Icon = state === "failed" ? WarningCircle : CloudArrowUp;
  return (
    <span className={`offline-mark offline-mark-${state}`} title={label}>
      <Icon size={13} aria-hidden="true" weight={state === "failed" ? "fill" : "regular"} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

// Plain text of the editor's HTML, for "Copy text".
function plainText(html: string) {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const block of doc.body.querySelectorAll("p, h1, h2, h3, h4, li, blockquote, pre, tr")) block.append("\n");
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

// On a page made offline: waiting (with the sending state), or failed.
export function OfflinePageNotice({
  state,
  reason,
  syncing,
  online,
  kind,
  html,
  onRetry,
  onDiscard,
}: {
  state: "pending" | "failed";
  reason?: string;
  syncing: boolean;
  online: boolean;
  kind: string;
  html: () => string;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (state === "pending")
    return (
      <p className="offline-page-note" role="status">
        <CloudArrowUp size={16} aria-hidden="true" />
        <span>
          {online && syncing
            ? t("Noch nicht synchronisiert – wird gerade übertragen …", "Not yet synced – being sent …")
            : t(
                "Noch nicht synchronisiert: Diese Seite gibt es bisher nur auf diesem Gerät. Sie wird angelegt, sobald die Verbindung zurück ist.",
                "Not yet synced: so far this page exists only on this device. It is created as soon as the connection is back.",
              )}
        </span>
      </p>
    );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText(html()));
      setCopied(true);
    } catch {}
  };
  return (
    <div className="offline-page-note failed" role="alert">
      <WarningCircle size={16} weight="fill" aria-hidden="true" />
      <div>
        <p>
          {t("Diese Seite konnte nicht synchronisiert werden", "This page could not be synced")}
          {reason ? `: ${reason}` : "."}{" "}
          {t("Ihr Inhalt bleibt auf diesem Gerät, bis du es erneut versuchst oder sie verwirfst.", "Its content stays on this device until you try again or discard it.")}
        </p>
        <div className="offline-page-actions">
          <button type="button" className="button compact" onClick={onRetry}>
            {t("Erneut versuchen", "Try again")}
          </button>
          {kind === "document" && (
            <button type="button" className="button compact" onClick={() => void copy()}>
              {copied ? t("Kopiert", "Copied") : t("Text kopieren", "Copy text")}
            </button>
          )}
          <button type="button" className="button compact danger" onClick={onDiscard}>
            {t("Verwerfen", "Discard")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Pictures and files of this page that could not be uploaded.
export function OfflineFailedUploads({
  failed,
  onRetry,
  onDiscard,
}: {
  failed: FailedChange[];
  onRetry: (fileId: string) => void;
  onDiscard: (fileId: string) => void;
}) {
  const t = useT();
  if (!failed.length) return null;
  return (
    <div className="offline-page-note failed" role="alert">
      <WarningCircle size={16} weight="fill" aria-hidden="true" />
      <ul className="offline-failed-files">
        {failed.map((f) =>
          f.change.kind === "upload" ? (
            <li key={f.change.fileId}>
              <p>
                {t(`„${f.change.name}“ konnte nicht hochgeladen werden`, `“${f.change.name}” could not be uploaded`)}
                {f.reason ? `: ${f.reason}` : "."}
              </p>
              <div className="offline-page-actions">
                <button type="button" className="button compact" onClick={() => onRetry((f.change as { fileId: string }).fileId)}>
                  {t("Erneut versuchen", "Try again")}
                </button>
                <button
                  type="button"
                  className="button compact"
                  onClick={async () => {
                    const kept = await keptUpload((f.change as { fileId: string }).fileId);
                    if (kept) downloadBlob(kept.name, kept.blob);
                  }}
                >
                  {t("Datei speichern", "Save file")}
                </button>
                <button type="button" className="button compact danger" onClick={() => onDiscard((f.change as { fileId: string }).fileId)}>
                  {t("Verwerfen", "Discard")}
                </button>
              </div>
            </li>
          ) : null,
        )}
      </ul>
    </div>
  );
}
