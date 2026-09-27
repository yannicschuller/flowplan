"use client";
// Following a page, who has read it and what changed since one's own last
// visit (components of the page header and above the content).
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
export function ago(ms: number, now = Date.now()) {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days === 1) return "gestern";
  if (days < 30) return `vor ${days} Tagen`;
  return new Date(ms).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
}
const names = (list: string[]) =>
  list.length <= 2 ? list.join(" und ") : `${list.slice(0, 2).join(", ")} und ${list.length - 2} weitere`;

export function FollowButton({
  following,
  followers,
  onToggle,
}: {
  following: boolean;
  followers: number;
  onToggle: (follow: boolean) => void;
}) {
  const label = following
    ? "Du folgst dieser Seite – Änderungen landen im Posteingang"
    : "Seite folgen: bei Änderungen benachrichtigen";
  return (
    <button
      type="button"
      className={`icon-button follow-button ${following ? "active" : ""}`}
      title={`${label}${followers ? ` (${followers} ${followers === 1 ? "folgt" : "folgen"})` : ""}`}
      aria-label={following ? "Nicht mehr folgen" : "Seite folgen"}
      aria-pressed={following}
      onClick={() => onToggle(!following)}
    >
      <Bell size={20} weight={following ? "fill" : "regular"} />
    </button>
  );
}

export function ReadersButton({ readers }: { readers: Reader[] }) {
  const others = readers.filter((r) => !r.self);
  if (!others.length) return null;
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="icon-button readers-button" aria-label={`Gesehen von ${others.length}`}>
        <Eye size={19} />
        <small>{others.length}</small>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu readers-menu" align="end" sideOffset={6}>
          <Dropdown.Label className="menu-label">Gesehen von</Dropdown.Label>
          {others.slice(0, 20).map((reader) => (
            <div className="reader" key={reader.id}>
              <Avatar name={reader.name} userId={reader.id} small />
              <span>
                <strong>{reader.name}</strong>
                <small>{ago(reader.seenAt)}</small>
              </span>
              {reader.current ? (
                <CheckCircle size={16} weight="fill" className="reader-current" aria-label="Neuester Stand gesehen" />
              ) : (
                <span className="reader-stale" title="Hat die letzten Änderungen noch nicht gesehen">
                  älter
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
  const [open, setOpen] = useState(false);
  const hasText = !!since.changes?.some((c) => c.type !== "same");
  return (
    <div className="since-visit" role="status">
      <span className="since-visit-dot" aria-hidden="true" />
      <span>
        Seit deinem letzten Besuch ({ago(since.seenAt)}) geändert von{" "}
        <strong>{names(since.editors)}</strong>
        {since.rows > 0 && ` · ${since.rows} ${since.rows === 1 ? "Eintrag" : "Einträge"} bearbeitet`}
      </span>
      {hasText && (
        <button type="button" className="text-button" onClick={() => setOpen(true)}>
          Änderungen zeigen
        </button>
      )}
      <button type="button" className="icon-button" aria-label="Hinweis schließen" onClick={onDismiss}>
        <X size={14} />
      </button>
      {open && since.changes && (
        <Modal open wide title="Seit deinem letzten Besuch" onClose={() => setOpen(false)}>
          <TextChanges changes={since.changes} />
        </Modal>
      )}
    </div>
  );
}
