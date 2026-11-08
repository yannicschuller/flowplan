"use client";
// Approvals of a workflow (docs/specs/workflows.md §8.7, §10.9): what is
// asked, of whom, and the decision – the approvers decide here with a
// comment (also on a phone; the notification opens this page). The first
// decision wins; a cancelled run says "no longer needed".
import { useCallback, useEffect, useId, useState } from "react";
import { Check, X } from "@phosphor-icons/react";
import { api } from "../ui";
import { StatusBadge } from "../settings-ui";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { type Approval, useStableT, type T } from "./model";

export function useApprovals(pageId: string, onError: (e: unknown) => void) {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const load = useCallback(async () => {
    try {
      setApprovals((await api<{ approvals: Approval[] }>(`/api/workflows/${pageId}/approvals`)).approvals);
    } catch (e) {
      onError(e);
    }
  }, [pageId, onError]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);
  return { approvals, reload: load };
}

const decisionText = (a: Approval, t: T) =>
  a.decision === "approved"
    ? t("Genehmigt", "Approved")
    : a.decision === "rejected"
      ? t("Abgelehnt", "Rejected")
      : a.decision === "timeout"
        ? t("Frist abgelaufen", "Timed out")
        : a.decision === "cancelled"
          ? t("Nicht mehr nötig", "No longer needed")
          : t("Offen", "Open");

export function ApprovalList({ approvals, onDecided, onOpenRun, onError }: { approvals: Approval[]; onDecided: () => void; onOpenRun: (runId: string) => void; onError: (e: unknown) => void }) {
  const t = useStableT();
  const mine = approvals.filter((a) => a.canDecide);
  const rest = approvals.filter((a) => !a.canDecide);
  return (
    <section className="wf-approvals" aria-label={t("Freigaben", "Approvals")}>
      {!approvals.length && <p className="muted wf-empty">{t("Noch keine Freigaben.", "No approvals yet.")}</p>}
      {mine.length > 0 && <h2 className="wf-section-title">{t("Wartet auf dich", "Waiting for you")}</h2>}
      {mine.map((a) => (
        <ApprovalCard key={a.id} approval={a} onDecided={onDecided} onOpenRun={onOpenRun} onError={onError} />
      ))}
      {rest.length > 0 && mine.length > 0 && <h2 className="wf-section-title">{t("Weitere", "Others")}</h2>}
      {rest.map((a) => (
        <ApprovalCard key={a.id} approval={a} onDecided={onDecided} onOpenRun={onOpenRun} onError={onError} />
      ))}
    </section>
  );
}

function ApprovalCard({ approval: a, onDecided, onOpenRun, onError }: { approval: Approval; onDecided: () => void; onOpenRun: (runId: string) => void; onError: (e: unknown) => void }) {
  const t = useStableT();
  const id = useId();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const time = new Intl.DateTimeFormat(LOCALE_TAG, { dateStyle: "medium", timeStyle: "short" });
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      await api("/api/command", { action: "workflow.approve", approvalId: a.id, decision, comment });
      onDecided();
    } catch (e) {
      onError(e);
      onDecided();
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`wf-approval${a.canDecide ? " open" : ""}`} aria-labelledby={`${id}-msg`}>
      <header>
        <StatusBadge tone={a.decision === "approved" ? "ok" : a.decision === "rejected" || a.decision === "timeout" ? "error" : a.decision ? "off" : "info"}>{decisionText(a, t)}</StatusBadge>
        <span className="muted">
          {time.format(new Date(a.createdAt))}
          {a.expiresAt && !a.decision ? t(` · Frist bis ${time.format(new Date(a.expiresAt))}`, ` · deadline ${time.format(new Date(a.expiresAt))}`) : ""}
        </span>
      </header>
      <p id={`${id}-msg`} className="wf-approval-message">
        {a.message || t("Bitte genehmigen oder ablehnen.", "Please approve or reject.")}
      </p>
      <p className="muted small">
        {t("Freigebende: ", "Approvers: ")}
        {a.approvers.map((p) => p.name).join(", ")}
        {a.decidedBy ? t(` · entschieden von ${a.decidedBy.name}`, ` · decided by ${a.decidedBy.name}`) : ""}
        {a.decidedAt ? ` · ${time.format(new Date(a.decidedAt))}` : ""}
      </p>
      {a.comment && <blockquote className="wf-approval-comment">{a.comment}</blockquote>}
      {a.canDecide && (
        <>
          <div className="wf-field">
            <label className="wf-field-label" htmlFor={`${id}-comment`}>
              {t("Kommentar (optional)", "Comment (optional)")}
            </label>
            <textarea id={`${id}-comment`} rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <div className="wf-approval-actions">
            <button type="button" className="button" disabled={busy} onClick={() => decide("rejected")}>
              <X /> {t("Ablehnen", "Reject")}
            </button>
            <button type="button" className="button primary" disabled={busy} onClick={() => decide("approved")}>
              <Check /> {t("Genehmigen", "Approve")}
            </button>
          </div>
          <p className="muted small">{t("Der Workflow läuft danach weiter als die Person, als die er läuft – nicht als du.", "The workflow then goes on as the person it runs as – not as you.")}</p>
        </>
      )}
      <button type="button" className="text-button" onClick={() => onOpenRun(a.runId)}>
        {t("Lauf ansehen", "View the run")}
      </button>
    </article>
  );
}
