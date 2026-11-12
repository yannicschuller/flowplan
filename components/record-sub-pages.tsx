"use client";
// "Unterseiten" of a record (#231): below the record's document, in its
// dialog and on its page – the pages that sit below the record
// (pages.parent_row_id, lib/record-pages.ts), a way to add one, and a drop
// zone for pages dragged from the sidebar.
import { useState } from "react";
import { ArrowUpRight, Plus } from "@phosphor-icons/react";
import { pageLocationHash } from "@/lib/page-location";
import { shownPageIcon } from "@/lib/page-link-icons";
import type { Page } from "@/lib/types";
import { useT } from "./i18n";
import { PageIcon } from "./ui";

export function RecordSubPages({
  database,
  rowId,
  pages,
  editable,
  mutate,
  onError,
}: {
  database: Page;
  rowId: string;
  pages: Page[];
  editable: boolean;
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [dropping, setDropping] = useState(false);
  const children = pages
    .filter((p) => p.parent_id === database.id && p.parent_row_id === rowId && !p.deleted_at)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const changed = () => window.dispatchEvent(new Event("flowplan:pages-changed"));
  async function add() {
    setBusy(true);
    try {
      const result = (await mutate({
        action: "page.create",
        workspaceId: database.workspace_id,
        spaceId: database.space_id,
        parentId: database.id,
        parentRowId: rowId,
        kind: "document",
        title: t("Ohne Titel", "Untitled"),
      })) as { id?: string } | null;
      changed();
      if (result?.id) location.hash = pageLocationHash({ pageId: result.id });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function moveHere(source: string) {
    if (source === database.id) return;
    try {
      await mutate({ action: "page.move", pageId: source, targetId: database.id, placement: "inside", parentRowId: rowId, meta: "auto" });
      changed();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  if (!children.length && !editable) return null;
  return (
    <section
      className={`record-subpages${dropping ? " dropping" : ""}`}
      aria-label={t("Unterseiten", "Sub-pages")}
      onDragOver={(e) => {
        if (!editable || !e.dataTransfer.types.includes("application/x-flowplan-page")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        const source = e.dataTransfer.getData("application/x-flowplan-page");
        if (!editable || !source) return;
        e.preventDefault();
        setDropping(false);
        void moveHere(source);
      }}
    >
      <h3>{t("Unterseiten", "Sub-pages")}</h3>
      <div className="subpages">
        {children.map((p) => (
          <a key={p.id} href={pageLocationHash({ pageId: p.id })} className="record-subpage">
            <PageIcon name={shownPageIcon(p.icon, p.kind)} />
            {p.title || t("Ohne Titel", "Untitled")}
            <ArrowUpRight />
          </a>
        ))}
        {editable && (
          <button type="button" className="text-button" disabled={busy} onClick={() => void add()}>
            <Plus size={16} />
            {t("Unterseite hinzufügen", "Add sub-page")}
          </button>
        )}
      </div>
      {editable && dropping && <p className="muted small">{t("Loslassen, um die Seite unter diesen Eintrag zu verschieben.", "Drop to move the page below this record.")}</p>}
    </section>
  );
}
