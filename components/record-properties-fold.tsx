"use client";
// The properties of a database record, foldable (#186; the rules in
// lib/record-properties.ts). Open: a labelled chevron "Eigenschaften" above
// the list. Folded: one line – a few values as small chips and "+N
// Eigenschaften" – a button that opens them again. The list stays in the
// page, shrunk to no height and inert, so nothing about the values changes,
// the fold can glide and printing shows everything (app/page-properties.css).
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";
import { appCache, pageKey } from "@/lib/swr-cache";
import { propertyCountLabel } from "@/lib/page-properties";
import { isRecordFolded, PHONE_MEDIA, type RecordDevice } from "@/lib/record-properties";
import type { RecordPropertiesChoice } from "@/lib/page-view-prefs";

// Choices made in this tab, per database and kind of device, ahead of
// database data that may still be cached from before.
const sessionChoices = new Map<string, boolean>();

export function useRecordDevice(): RecordDevice {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia?.(PHONE_MEDIA);
      query?.addEventListener("change", onChange);
      return () => query?.removeEventListener("change", onChange);
    },
    () => (window.matchMedia?.(PHONE_MEDIA).matches ? "phone" : "desktop"),
    () => "desktop",
  );
}

export function RecordPropertiesFold({
  databaseId,
  rowId,
  count,
  choice,
  device,
  fresh = false,
  summary,
  children,
}: {
  databaseId: string;
  rowId: string;
  // How many properties the record shows (the default and "+N").
  count: number;
  // The person's stored choices for this database (null: none).
  choice?: RecordPropertiesChoice | null;
  device: RecordDevice;
  // A record just created opens with its properties shown: they are what
  // one fills in first.
  fresh?: boolean;
  // The chips of the folded line ("+N" for the properties they leave out).
  summary: ReactNode[];
  children: ReactNode;
}) {
  const t = useT();
  const bodyId = useId();
  const stored = sessionChoices.get(`${databaseId}:${device}`) ?? choice?.[device] ?? null;
  // Decided once when a record opens; `moved` only after a toggle (opening
  // never animates); `choice`: the stored choice it was decided from – a
  // fresh one (the kept copy of the data may be older) decides again unless
  // the person toggled meanwhile.
  const decide = () => !fresh && isRecordFolded(stored, count, device);
  const [fold, setFold] = useState(() => ({ rowId, device, collapsed: decide(), moved: false, choice: stored }));
  if (fold.rowId !== rowId || fold.device !== device) setFold({ rowId, device, collapsed: decide(), moved: false, choice: stored });
  else if (!fold.moved && fold.choice !== stored) setFold({ ...fold, collapsed: decide(), choice: stored });
  const summaryRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"summary" | "toggle" | null>(null);
  useEffect(() => {
    const target = focusAfter.current === "summary" ? summaryRef.current : focusAfter.current === "toggle" ? toggleRef.current : null;
    focusAfter.current = null;
    target?.focus();
  }, [fold.collapsed]);
  const collapsed = fold.collapsed;
  const toggle = () => {
    const next = !collapsed;
    sessionChoices.set(`${databaseId}:${device}`, next);
    focusAfter.current = next ? "summary" : "toggle";
    setFold({ rowId, device, collapsed: next, moved: true, choice: next });
    // The kept copy of the database opens records the same way next time.
    const cache = appCache();
    const kept = cache.get<Record<string, unknown>>(pageKey(databaseId));
    if (kept) {
      const before = (kept.value.recordPropertiesCollapsed as RecordPropertiesChoice | undefined) ?? { phone: null, desktop: null };
      cache.set(
        pageKey(databaseId),
        { ...kept.value, recordPropertiesCollapsed: { ...before, [device]: next } },
        { version: kept.version, policy: kept.persist ? "persist" : "memory" },
      );
    }
    // Stored in the account; a failure (offline) keeps it for this tab.
    void api("/api/command", { action: "database.collapseRecordProperties", pageId: databaseId, device, collapsed: next }).catch(() => {});
  };
  const label = t("Eigenschaften", "Properties");
  // Nothing to fold (all properties empty and hidden, or none).
  if (count === 0) return <>{children}</>;
  const more = count - summary.length;
  return (
    <div className={`record-properties${collapsed ? " collapsed" : ""}${fold.moved ? " animated" : ""}`} role="group" aria-label={label}>
      {collapsed ? (
        <button
          ref={summaryRef}
          type="button"
          className="record-properties-summary"
          aria-expanded={false}
          aria-controls={bodyId}
          title={t("Eigenschaften ausklappen", "Expand properties")}
          onClick={toggle}
        >
          <CaretRight size={13} weight="bold" className="page-properties-caret" aria-hidden />
          <span className="sr-only">{t("Eigenschaften ausklappen:", "Expand properties:")} </span>
          {summary.length === 0 && <span className="record-properties-label">{label}</span>}
          {summary}
          {more > 0 && (
            <span className="page-properties-count">
              {summary.length > 0 ? (more === 1 ? t("+1 Eigenschaft", "+1 property") : t(`+${more} Eigenschaften`, `+${more} properties`)) : propertyCountLabel(more, t)}
            </span>
          )}
        </button>
      ) : (
        <button
          ref={toggleRef}
          type="button"
          className="record-properties-toggle"
          aria-expanded
          aria-controls={bodyId}
          title={t("Eigenschaften einklappen", "Collapse properties")}
          onClick={toggle}
        >
          <CaretRight size={13} weight="bold" className="page-properties-caret" aria-hidden />
          <span className="record-properties-label">{label}</span>
        </button>
      )}
      <div className="record-properties-body" id={bodyId} inert={collapsed}>
        <div className="record-properties-inner">{children}</div>
      </div>
    </div>
  );
}
