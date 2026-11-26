"use client";
// Administration → Überwachung → Fehler im Detail: "GitHub-Issue öffnen"
// shows exactly what goes to GitHub – the title and the fields of the bug
// report template, from the public report (lib/error-report.ts publicReport:
// no request ids, instance or host names, roles, addresses) – and opens the
// new issue in a new tab. The address is built here in the browser; the
// server never talks to GitHub. "Als gemeldet markieren" stores the fact
// (and the issue's address, if pasted) for the weekly digest.
import { useState } from "react";
import { ArrowSquareOut, Copy } from "@phosphor-icons/react";
import { githubIssue, publicReportText, type PublicErrorReport } from "@/lib/error-report";
import { useT } from "../../i18n";
import { Modal } from "../../ui";

export function ErrorIssueDialog({ report, onClose }: { report: PublicErrorReport; onClose: () => void }) {
  const t = useT();
  const issue = githubIssue(report);
  const [copied, setCopied] = useState(false);
  const fields: [string, string][] = [
    [t("Was ist passiert?", "What happened?"), issue.fields.what],
    [t("Schritte zum Nachstellen", "Steps to reproduce"), issue.fields.steps],
    [t("Was hast du erwartet?", "What did you expect?"), issue.fields.expected],
    [t("Flowplan-Version", "Flowplan version"), issue.fields.version],
    [t("Protokoll", "Logs"), issue.fields.logs],
  ];
  return (
    <Modal open onClose={onClose} title={t("GitHub-Issue: Vorschau", "GitHub issue: preview")} className="error-issue-dialog" wide sheet>
      <div className="error-issue">
        <p className="muted">
          {t(
            "Genau das steht im neuen Issue, das GitHub in einem neuen Tab öffnet – erst dein Klick dort auf „Create“ schickt es ab. Keine Fehler-IDs, keine Instanz- oder Hostnamen, keine Rollen.",
            "Exactly this goes into the new issue that GitHub opens in a new tab – only your click on “Create” there sends it. No error IDs, no instance or host names, no roles.",
          )}
        </p>
        <h3 className="mon-subhead">{t("Titel", "Title")}</h3>
        <pre className="mon-error-stack error-issue-text" tabIndex={0}>
          {issue.title}
        </pre>
        {fields.map(([label, text]) => (
          <section key={label} aria-label={label}>
            <h3 className="mon-subhead">{label}</h3>
            <pre className="mon-error-stack error-issue-text" tabIndex={0}>
              {text}
            </pre>
          </section>
        ))}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(publicReportText(report))
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
                .catch(() => {})
            }
          >
            <Copy size={15} aria-hidden /> {copied ? t("Kopiert", "Copied") : t("Bericht kopieren", "Copy report")}
          </button>
          <a className="button primary" href={issue.url} target="_blank" rel="noopener noreferrer">
            <ArrowSquareOut size={15} aria-hidden /> {t("Auf GitHub öffnen", "Open on GitHub")}
          </a>
        </div>
      </div>
    </Modal>
  );
}

// "Als gemeldet markieren": the issue's address is optional.
export function MarkReportedDialog({ onClose, onSave }: { onClose: () => void; onSave: (issueUrl: string) => Promise<void> }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  return (
    <Modal open onClose={() => !busy && onClose()} title={t("Als gemeldet markieren", "Mark as reported")}>
      <form
        className="ws-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setFailed("");
          try {
            await onSave(url.trim());
            onClose();
          } catch (error) {
            setFailed((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          {t(
            "Die wöchentliche Fehlerübersicht nennt diese Fehlerart dann nicht mehr – erst wieder, wenn sie nach vier ruhigen Wochen zurückkommt.",
            "The weekly error summary then no longer names this kind of error – only again if it comes back after four quiet weeks.",
          )}
        </p>
        {failed && (
          <p role="alert" className="error">
            {failed}
          </p>
        )}
        <div className="ws-field">
          <label htmlFor="error-issue-url">{t("Adresse des Issues (optional)", "Address of the issue (optional)")}</label>
          <input id="error-issue-url" type="url" inputMode="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/yannicschuller/flowplan/issues/…" maxLength={300} disabled={busy} />
        </div>
        <div className="modal-actions ws-form-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {t("Als gemeldet markieren", "Mark as reported")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
