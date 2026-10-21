"use client";
// Aliases of a page: other names by which @ mentions, the search and
// unlinked mentions find it ("PAC" for "Chauffage"). The page menu opens
// the dialog with the event "flowplan:page-aliases".
import { useEffect, useState } from "react";
import { Tag, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { aliasList, MAX_ALIAS_LENGTH, MAX_ALIASES, pageAliases } from "@/lib/aliases";
import type { Page } from "@/lib/types";

type Act = (b: Record<string, unknown>) => Promise<unknown>;
export const AliasIcon = Tag;
export const openPageAliases = (pageId: string) => window.dispatchEvent(new CustomEvent("flowplan:page-aliases", { detail: pageId }));

export function PageAliases({ page, editable, act }: { page: Page; editable: boolean; act: Act }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const listen = (e: Event) => (e as CustomEvent<string>).detail === page.id && setOpen(true);
    window.addEventListener("flowplan:page-aliases", listen);
    return () => window.removeEventListener("flowplan:page-aliases", listen);
  }, [page.id]);
  return open ? <PageAliasesDialog page={page} editable={editable} act={act} onClose={() => setOpen(false)} /> : null;
}

function PageAliasesDialog({ page, editable, act, onClose }: { page: Page; editable: boolean; act: Act; onClose: () => void }) {
  const t = useT();
  const [aliases, setAliases] = useState(() => pageAliases(page));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const full = aliases.length >= MAX_ALIASES;
  const add = () => {
    if (!draft.trim()) return;
    setAliases((list) => aliasList([...list, ...draft.split(",")]));
    setDraft("");
  };
  const save = async () => {
    setBusy(true);
    try {
      const list = aliasList([...aliases, ...draft.split(",")]);
      if (await act({ action: "page.aliases", pageId: page.id, aliases: list })) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={t("Aliasse", "Aliases")} onClose={onClose}>
      <form
        className="page-aliases-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="muted">
          {t(
            "Andere Namen dieser Seite, z. B. Abkürzungen. @-Erwähnungen, die Suche und nicht verlinkte Erwähnungen finden die Seite auch darüber.",
            "Other names of this page, such as abbreviations. @ mentions, search and unlinked mentions find the page by them too.",
          )}
        </p>
        {aliases.length > 0 && (
          <ul className="page-aliases-list">
            {aliases.map((alias) => (
              <li key={alias} className="chip">
                {alias}
                {editable && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t(`„${alias}“ entfernen`, `Remove “${alias}”`)}
                    onClick={() => setAliases((list) => list.filter((a) => a !== alias))}
                  >
                    <X size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <label>
            <span>{t("Alias hinzufügen", "Add an alias")}</span>
            <input
              value={draft}
              maxLength={MAX_ALIAS_LENGTH * 3}
              disabled={full}
              placeholder={full ? t("Höchstens 10 Aliasse", "At most 10 aliases") : t("z. B. PAC, dann Enter", "e.g. PAC, then Enter")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </label>
        )}
        {editable && (
          <div className="modal-actions">
            <button className="button primary" disabled={busy}>
              {t("Speichern", "Save")}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
