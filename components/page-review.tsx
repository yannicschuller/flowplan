"use client";
// Page owner and review date ("Prüfdatum"): a quiet hint on pages whose
// review is due, with "Geprüft", and the dialog to set owner and date. The
// page menu opens the dialog with the event "flowplan:page-review".
import { useEffect, useState } from "react";
import { SealCheck, UserCircle } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";
import { Modal } from "./ui";
import { PageAliases } from "./page-aliases";
import type { Page, User } from "@/lib/types";

type Member = Pick<User, "id" | "name"> & { guest?: number; disabled?: number };
type Act = (b: Record<string, unknown>) => Promise<unknown>;

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const openPageReview = (pageId: string) => window.dispatchEvent(new CustomEvent("flowplan:page-review", { detail: pageId }));

export function PageReview({ page, members, editable, act }: { page: Page; members: Member[]; editable: boolean; act: Act }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const listen = (e: Event) => (e as CustomEvent<string>).detail === page.id && setOpen(true);
    window.addEventListener("flowplan:page-review", listen);
    return () => window.removeEventListener("flowplan:page-review", listen);
  }, [page.id]);
  const owner = members.find((m) => m.id === page.owner_id);
  const due = !!page.review_at && page.review_at <= todayLocal();
  return (
    <>
      {due && (
        <div className="page-review-banner" role="status">
          <SealCheck size={16} aria-hidden />
          <span>
            {owner
              ? t(`Diese Seite wartet auf eine Prüfung (Besitzer: ${owner.name}).`, `This page is waiting for a review (owner: ${owner.name}).`)
              : t("Diese Seite wartet auf eine Prüfung.", "This page is waiting for a review.")}
          </span>
          {editable && (
            <>
              <button type="button" className="text-button" onClick={() => setOpen(true)}>
                {t("Ändern", "Change")}
              </button>
              <button type="button" className="button compact" onClick={() => void act({ action: "page.review", pageId: page.id, done: true })}>
                {t("Geprüft", "Reviewed")}
              </button>
            </>
          )}
        </div>
      )}
      {open && <PageReviewDialog page={page} members={members} editable={editable} act={act} onClose={() => setOpen(false)} />}
      <PageAliases page={page} editable={editable} act={act} />
    </>
  );
}

function PageReviewDialog({ page, members, editable, act, onClose }: { page: Page; members: Member[]; editable: boolean; act: Act; onClose: () => void }) {
  const t = useT();
  const [ownerId, setOwnerId] = useState(page.owner_id || "");
  const [reviewAt, setReviewAt] = useState(page.review_at || "");
  const [every, setEvery] = useState(page.review_every_days ? String(page.review_every_days) : "");
  const [busy, setBusy] = useState(false);
  const candidates = members.filter((m) => !m.guest && !m.disabled);
  const save = async (clear = false) => {
    setBusy(true);
    try {
      const days = Math.round(Number(every));
      const everyDays = clear || !every || !Number.isFinite(days) || days < 1 ? null : Math.min(3650, days);
      if ((ownerId || null) !== (page.owner_id || null) || clear)
        if (!(await act({ action: "page.owner", pageId: page.id, ownerId: clear ? null : ownerId || null }))) return;
      if (!(await act({ action: "page.review", pageId: page.id, reviewAt: clear ? null : reviewAt || null, everyDays }))) return;
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={t("Besitzer und Prüfung", "Owner and review")} onClose={onClose}>
      <form
        className="page-review-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="muted">
          {t(
            "Der Besitzer kümmert sich um die Seite und wird erinnert, sobald das Prüfdatum erreicht ist.",
            "The owner looks after the page and is reminded once the review date has come.",
          )}
        </p>
        <label>
          <span>
            <UserCircle size={15} aria-hidden /> {t("Besitzer", "Owner")}
          </span>
          <Select aria-label={t("Besitzer", "Owner")} value={ownerId} disabled={!editable} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">{t("Niemand", "Nobody")}</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span>{t("Nächste Prüfung am", "Next review on")}</span>
          <input type="date" value={reviewAt} disabled={!editable} onChange={(e) => setReviewAt(e.target.value)} />
        </label>
        <label>
          <span>{t("Danach alle … Tage", "Then every … days")}</span>
          <input
            type="number"
            min={1}
            max={3650}
            inputMode="numeric"
            placeholder={t("einmalig", "once")}
            value={every}
            disabled={!editable}
            onChange={(e) => setEvery(e.target.value)}
          />
        </label>
        <div className="page-review-presets">
          {[30, 90, 180, 365].map((days) => (
            <button key={days} type="button" className="chip" disabled={!editable} aria-pressed={every === String(days)} onClick={() => setEvery(String(days))}>
              {days === 365 ? t("jährlich", "yearly") : t(`${days} Tage`, `${days} days`)}
            </button>
          ))}
        </div>
        {editable && (
          <div className="modal-actions">
            {(page.owner_id || page.review_at || page.review_every_days) && (
              <button type="button" className="button" disabled={busy} onClick={() => void save(true)}>
                {t("Entfernen", "Remove")}
              </button>
            )}
            <button className="button primary" disabled={busy}>
              {t("Speichern", "Save")}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
