"use client";
// Following a page, who has read it and what changed since one's own last
// visit (components of the page header and above the content).
import { useLocale, useT } from "./i18n";
import { useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Bell, CheckCircle, Eye, X } from "@phosphor-icons/react";
import { Avatar, Modal } from "./ui";
import { TextChanges } from "./version-changes";
import type { TextChange } from "@/lib/text-diff";

export type Reader = {
  id: string;
  name: string;
  seenAt: number;
  current: boolean;
  self: boolean;
};
export type SinceVisit = {
  seenAt: number;
  editors: string[];
  changes: TextChange[] | null;
  rows: number;
};
export function ago(ms: number, now = Date.now(), locale: "de" | "en" = "de") {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return t("gerade eben", "just now");
  if (minutes < 60) return t(`vor ${minutes} Min.`, `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t(`vor ${hours} Std.`, `${hours} h ago`);
  const days = Math.round(hours / 24);
  if (days === 1) return t("gestern", "yesterday");
  if (days < 30) return t(`vor ${days} Tagen`, `${days} days ago`);
  return new Date(ms).toLocaleDateString(t("de-DE", "en-GB"), { day: "numeric", month: "long", year: "numeric" });
}
const names = (list: string[], t: (de: string, en: string) => string) =>
  list.length <= 2
    ? list.join(t(" und ", " and "))
    : t(`${list.slice(0, 2).join(", ")} und ${list.length - 2} weitere`, `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`);

export function FollowButton({
  following,
  followers,
  onToggle,
}: {
  following: boolean;
  followers: number;
  onToggle: (follow: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const label = following
    ? t("Du folgst dieser Seite – Änderungen landen im Posteingang", "You follow this page – changes land in your inbox")
    : t("Seite folgen: bei Änderungen benachrichtigen", "Follow page: get notified about changes");
  return (
    <button
      type="button"
      className={`icon-button follow-button ${following ? "active" : ""}`}
      title={`${label}${followers ? ` (${followers} ${followers === 1 ? "folgt" : "folgen"})` : ""}`}
      aria-label={following ? t("Nicht mehr folgen", "Unfollow") : t("Seite folgen", "Follow page")}
      aria-pressed={following}
      onClick={() => onToggle(!following)}
    >
      <Bell size={20} weight={following ? "fill" : "regular"} />
    </button>
  );
}

export function ReadersButton({ readers }: { readers: Reader[] }) {
  const t = useT();
  const locale = useLocale();
  const others = readers.filter((r) => !r.self);
  if (!others.length) return null;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="icon-button readers-button" aria-label={t(`Gesehen von ${others.length}`, `Seen by ${others.length}`)}>
        <Eye size={19} />
        <small>{others.length}</small>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu readers-menu" align="end" sideOffset={6}>
          <Dropdown.Label className="menu-label">{t("Gesehen von", "Seen by")}</Dropdown.Label>
          {others.slice(0, 20).map((reader) => (
            <div className="reader" key={reader.id}>
              <Avatar name={reader.name} userId={reader.id} small />
              <span>
                <strong>{reader.name}</strong>
                <small>{ago(reader.seenAt, Date.now(), locale)}</small>
              </span>
              {reader.current ? (
                <CheckCircle size={16} weight="fill" className="reader-current" aria-label={t("Neuester Stand gesehen", "Saw the latest state")} />
              ) : (
                <span className="reader-stale" title={t("Hat die letzten Änderungen noch nicht gesehen", "Has not seen the latest changes yet")}>
                  {t("älter", "older")}
                </span>
              )}
            </div>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function SinceVisitBanner({
  since,
  onDismiss,
}: {
  since: SinceVisit;
  onDismiss: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const hasText = !!since.changes?.some((c) => c.type !== "same");
  return (
    <div className="since-visit" role="status">
      <span className="since-visit-dot" aria-hidden="true" />
      <span>
        {t("Seit deinem letzten Besuch (", "Since your last visit (")}{ago(since.seenAt, Date.now(), locale)}{t(") geändert von", ") changed by")}{" "}
        <strong>{names(since.editors, t)}</strong>
        {since.rows > 0 && ` · ${since.rows} ${since.rows === 1 ? "Eintrag" : "Einträge"} bearbeitet`}
      </span>
      {hasText && (
        <button type="button" className="text-button" onClick={() => setOpen(true)}>
          {t("Änderungen zeigen", "Show changes")}
        </button>
      )}
      <button type="button" className="icon-button" aria-label={t("Hinweis schließen", "Close notice")} onClick={onDismiss}>
        <X size={14} />
      </button>
      {open && since.changes && (
        <Modal open wide title={t("Seit deinem letzten Besuch", "Since your last visit")} onClose={() => setOpen(false)}>
          <TextChanges changes={since.changes} />
        </Modal>
      )}
    </div>
  );
}
