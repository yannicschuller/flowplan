"use client";
// The template gallery of the board: ready-made boards by category with a
// preview and a search, and the workspace's own templates – saved from the
// whole board or the selection, for everyone in the workspace or only for
// oneself (lib/whiteboard-user-templates.ts).
import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlass, Trash } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal, api } from "../ui";
import { WhiteboardStatic } from "./render";
import { findTemplates, galleryCategories, type Draft, type GalleryCategory } from "@/lib/whiteboard-template-gallery";
import { templateDrafts } from "@/lib/whiteboard-template-save";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

type Own = { id: string; name: string; private: boolean; author: string; items: Draft[]; canDelete: boolean };
const preview = (drafts: Draft[]) => drafts.map((d, i) => ({ ...d, z: d.z ?? i }) as WhiteboardItem);

export function TemplateGallery({
  open,
  tab: initialTab,
  pageId,
  editable,
  items,
  selection,
  onClose,
  onInsert,
  onError,
}: {
  open: boolean;
  tab: "gallery" | "own" | "save";
  pageId: string;
  editable: boolean;
  items: WhiteboardItem[];
  selection: Set<string>;
  onClose: () => void;
  onInsert: (drafts: Draft[]) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"gallery" | "own" | "save">(initialTab);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState<GalleryCategory | "">(""),
    [own, setOwn] = useState<Own[] | null>(null),
    [name, setName] = useState(""),
    [scope, setScope] = useState<"selection" | "board">("board"),
    [mine, setMine] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setScope(selection.size ? "selection" : "board");
  }, [open, initialTab, selection.size]);
  const load = async () => {
    try {
      setOwn((await api<{ templates: Own[] }>(`/api/whiteboards/${pageId}/templates`)).templates);
    } catch (e) {
      setOwn([]);
      onError((e as Error).message);
    }
  };
  useEffect(() => {
    if (open && tab !== "gallery" && own === null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);
  const found = findTemplates(query, t, category);
  const ownShown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase("de");
    return (own || []).filter((o) => !words || o.name.toLocaleLowerCase("de").includes(words));
  }, [own, query]);
  async function save() {
    const source = scope === "selection" ? items.filter((i) => selection.has(i.id)) : items;
    const drafts = templateDrafts(source, items);
    if (!drafts.length) return onError(t("Es gibt nichts, was sich als Vorlage speichern lässt.", "There is nothing that can be saved as a template."));
    setBusy(true);
    try {
      await api(`/api/whiteboards/${pageId}/templates`, { action: "save", name: name.trim(), items: drafts, private: mine });
      setName("");
      await load();
      setTab("own");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={t("Vorlagen", "Templates")} wide sheet className="wb-template-gallery">
      <div className="journal-layout wb-template-tabs" role="tablist" aria-label={t("Vorlagen", "Templates")}>
        <button type="button" role="tab" aria-selected={tab === "gallery"} className={tab === "gallery" ? "active" : ""} onClick={() => setTab("gallery")}>
          {t("Galerie", "Gallery")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "own"} className={tab === "own" ? "active" : ""} onClick={() => setTab("own")}>
          {t("Eigene Vorlagen", "Own templates")}
        </button>
        {editable && (
          <button type="button" role="tab" aria-selected={tab === "save"} className={tab === "save" ? "active" : ""} onClick={() => setTab("save")}>
            {t("Als Vorlage speichern", "Save as template")}
          </button>
        )}
      </div>
      {tab !== "save" && (
        <div className="wb-media-query">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Vorlagen suchen …", "Search templates …")}
            aria-label={t("Vorlagen suchen", "Search templates")}
          />
        </div>
      )}
      {tab === "gallery" && (
        <>
          <div className="wb-template-categories" role="radiogroup" aria-label={t("Kategorie", "Category")}>
            <button type="button" role="radio" aria-checked={category === ""} className={category === "" ? "active" : ""} onClick={() => setCategory("")}>
              {t("Alle", "All")}
            </button>
            {galleryCategories.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={category === c.id} className={category === c.id ? "active" : ""} onClick={() => setCategory(c.id)}>
                {c.name(t)}
              </button>
            ))}
          </div>
          {!found.length && <p className="muted">{t("Keine passende Vorlage.", "No matching template.")}</p>}
          <div className="wb-template-grid">
            {found.map((template) => (
              <button
                key={template.id}
                type="button"
                className="wb-template-card"
                disabled={!editable}
                data-template={template.id}
                onClick={() => onInsert(template.items(t))}
              >
                <WhiteboardStatic items={preview(template.items(t))} pages={[]} height={110} />
                <strong>{template.name(t)}</strong>
                <small>{template.description(t)}</small>
              </button>
            ))}
          </div>
        </>
      )}
      {tab === "own" &&
        (own === null ? (
          <p className="muted">{t("Vorlagen werden geladen …", "Loading templates …")}</p>
        ) : !ownShown.length ? (
          <p className="muted">
            {own.length
              ? t("Keine passende Vorlage.", "No matching template.")
              : t("Noch keine eigenen Vorlagen. Speichere ein Board oder eine Auswahl als Vorlage.", "No own templates yet. Save a board or a selection as a template.")}
          </p>
        ) : (
          <div className="wb-template-grid">
            {ownShown.map((template) => (
              <div key={template.id} className="wb-template-card own">
                <button type="button" disabled={!editable} onClick={() => onInsert(template.items)} aria-label={t(`Vorlage „${template.name}“ einfügen`, `Insert template “${template.name}”`)}>
                  <WhiteboardStatic items={preview(template.items)} pages={[]} height={110} />
                  <strong>{template.name}</strong>
                  <small>
                    {template.private ? t("Nur für dich", "Only for you") : t("Für den Arbeitsbereich", "For the workspace")}
                    {template.author ? ` · ${template.author}` : ""}
                  </small>
                </button>
                {template.canDelete && (
                  <button
                    type="button"
                    className="icon-button wb-template-delete"
                    aria-label={t(`Vorlage „${template.name}“ löschen`, `Delete template “${template.name}”`)}
                    onClick={async () => {
                      try {
                        await api(`/api/whiteboards/${pageId}/templates`, { action: "delete", templateId: template.id });
                        await load();
                      } catch (e) {
                        onError((e as Error).message);
                      }
                    }}
                  >
                    <Trash size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      {tab === "save" && editable && (
        <form
          className="wb-template-save"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save();
          }}
        >
          <label>
            {t("Name", "Name")}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required autoFocus placeholder={t("z. B. Team-Retro", "e.g. Team retro")} />
          </label>
          <fieldset>
            <legend>{t("Was speichern", "What to save")}</legend>
            <label className="wb-check">
              <input type="radio" name="scope" checked={scope === "board"} onChange={() => setScope("board")} />
              {t("Das ganze Board", "The whole board")}
            </label>
            <label className="wb-check">
              <input type="radio" name="scope" checked={scope === "selection"} disabled={!selection.size} onChange={() => setScope("selection")} />
              {t(`Die Auswahl (${selection.size} Elemente)`, `The selection (${selection.size} elements)`)}
            </label>
          </fieldset>
          <label className="wb-check">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            {t("Nur für mich", "Only for me")}
          </label>
          <p className="muted">{t("Kommentare, Stimmen und Stempel bleiben auf dem Board.", "Comments, votes and stamps stay on the board.")}</p>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? t("Wird gespeichert …", "Saving …") : t("Als Vorlage speichern", "Save as template")}
          </button>
        </form>
      )}
    </Modal>
  );
}
