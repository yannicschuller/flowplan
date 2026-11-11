"use client";
// "Neue Seite": the name on top, the kinds of page as compact tiles (a radio
// group, arrow keys move through it), one line about the chosen kind, its
// options in place below and the space as one row. The buttons stay at the
// bottom edge of the dialog – on phones above the on-screen keyboard, the
// sheet ends at it, as high as its content, and its middle scrolls when the
// content does not fit (app/new-page-dialog.css).
import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import {
  FileText,
  FlowArrow,
  Folder,
  Gauge,
  Notebook,
  NotePencil,
  PresentationChart,
  Sparkle,
  SquaresFour,
  Table,
  type Icon,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";
import { DuplicateHint } from "./related-pages";
import { AiDatabaseCreator, type DatabaseProposal } from "./ai-database";
import { DatabaseKindPicker, rememberedDatabaseKind, type DatabaseChoice } from "./database-kind-picker";
import { aiUsable } from "@/lib/ai/client";
import type { Bootstrap, PageKind } from "@/lib/types";

type Choice = PageKind | "template";

// The sheet's own height as --np-height: with the keyboard open the CSS puts
// its lower edge at the keyboard from the top (iOS resolves bottom: against
// the height from before the keyboard) and needs the height for it. Kept up
// to date as the content or the room changes. A ref callback on the form;
// React calls the returned cleanup when it goes.
function trackSheetHeight(form: HTMLFormElement | null) {
  const sheet = form?.closest<HTMLElement>(".modal");
  if (!sheet || typeof ResizeObserver === "undefined") return;
  const measure = () => sheet.style.setProperty("--np-height", `${Math.ceil(sheet.getBoundingClientRect().height)}px`);
  const observer = new ResizeObserver(measure);
  observer.observe(sheet);
  measure();
  return () => {
    observer.disconnect();
    sheet.style.removeProperty("--np-height");
  };
}
// Up and down move by a row of tiles (app/new-page-dialog.css).
const COLUMNS = 4;

export function NewPageDialog({
  open,
  onClose,
  boot,
  title,
  onTitle,
  kind,
  onKind,
  template,
  titleFromTemplate,
  onTemplateTitle,
  onTemplates,
  databaseChoice,
  onDatabaseChoice,
  aiCreate,
  onAiCreate,
  aiProposal,
  onAiProposal,
  onNotebookPdf,
  spaceId,
  onSpace,
  onOpenDuplicate,
  onError,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  boot: Pick<Bootstrap, "workspace" | "spaces" | "ai">;
  title: string;
  onTitle: (title: string) => void;
  kind: PageKind;
  // A kind of page chosen (clears a chosen template).
  onKind: (kind: PageKind) => void;
  // The template chosen in the gallery (built-in or saved), if any.
  template: { name: string } | null;
  // The name field holds the template's name, not one typed by hand: it is
  // selected when the dialog opens, so typing replaces it (#213).
  titleFromTemplate: boolean;
  // A database template in the kind picker: its name, unless one was typed.
  onTemplateTitle: (name: string) => void;
  // "Aus Vorlage": the template gallery takes over (#112).
  onTemplates: () => void;
  databaseChoice: DatabaseChoice;
  onDatabaseChoice: (choice: DatabaseChoice) => void;
  aiCreate: boolean;
  onAiCreate: (on: boolean) => void;
  aiProposal: DatabaseProposal | null;
  onAiProposal: (proposal: DatabaseProposal | null) => void;
  onNotebookPdf: (file: File | null) => void;
  spaceId: string;
  onSpace: (spaceId: string) => void;
  onOpenDuplicate: (pageId: string, rowId?: string) => void;
  onError: (message: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const t = useT();
  const name = useRef<HTMLInputElement>(null);
  // A template's name in the field: selected the first time the field gets
  // the focus after opening (autoFocus or onOpenAutoFocus), so typing
  // replaces it (#213).
  const selected = useRef(false);
  useEffect(() => {
    if (!open) selected.current = false;
  }, [open]);
  const tiles = useRef<HTMLDivElement>(null);
  const chosen: Choice = template ? "template" : kind;
  const aiDatabase = aiUsable(boot.ai, "database");
  const database = kind === "database" && !template;
  const types: { id: Choice; icon: Icon; label: string; description: string }[] = [
    {
      id: "document",
      icon: FileText,
      label: t("Dokument", "Document"),
      description: t("Notizen, Wissen und Ideen – Text mit Überschriften, Listen, Tabellen und Bildern", "Notes, knowledge and ideas – text with headings, lists, tables and images"),
    },
    {
      id: "database",
      icon: Table,
      label: t("Datenbank", "Database"),
      description: t("Aufgaben und strukturierte Daten – Tabelle, Board, Kalender …", "Tasks and structured data – table, board, calendar …"),
    },
    {
      id: "whiteboard",
      icon: PresentationChart,
      label: t("Whiteboard", "Whiteboard"),
      description: t("Ideen, Diagramme und Workshops auf einer unendlichen Fläche", "Ideas, diagrams and workshops on an endless canvas"),
    },
    { id: "journal", icon: Notebook, label: t("Journal", "Journal"), description: t("Jeden Tag eine Seite, offene Aufgaben wandern mit", "A page every day, open tasks move along") },
    { id: "dashboard", icon: Gauge, label: t("Dashboard", "Dashboard"), description: t("Kennzahlen, Diagramme und Aufgaben auf einen Blick", "Metrics, charts and tasks at a glance") },
    { id: "notebook", icon: NotePencil, label: t("Notizbuch", "Notebook"), description: t("Handschrift auf Papier oder PDFs, mit Stift", "Handwriting on paper or PDFs, with a pen") },
    ...(boot.workspace.guest
      ? []
      : [{ id: "workflow" as const, icon: FlowArrow, label: t("Workflow", "Workflow"), description: t("Abläufe automatisch: wenn etwas passiert, dann …", "Automatic flows: when something happens, then …") }]),
    {
      id: "template",
      icon: SquaresFour,
      label: template ? t("Vorlage gewählt", "Template chosen") : t("Aus Vorlage", "From a template"),
      description: template
        ? t(`Vorlage „${template.name}“ – tippe, um eine andere zu wählen`, `Template “${template.name}” – tap to choose another one`)
        : t("Besprechungsnotizen, Projektsteckbrief, Spezifikation … und deine gespeicherten Vorlagen", "Meeting notes, project brief, spec … and your saved templates"),
    },
  ];
  const choose = (id: Choice) => {
    if (id === "template") return onTemplates();
    if (id === "database" && chosen !== "database") onDatabaseChoice(rememberedDatabaseKind());
    onKind(id);
  };
  // Arrow keys move through the tiles and choose (the template tile only
  // takes the focus: choosing it opens the gallery). In right-to-left
  // languages left and right swap.
  const arrows = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(tiles.current?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const n = buttons.length;
    let next: number;
    if (e.key === "ArrowRight") next = (at + (rtl ? n - 1 : 1)) % n;
    else if (e.key === "ArrowLeft") next = (at + (rtl ? 1 : n - 1)) % n;
    else if (e.key === "ArrowDown") next = at + COLUMNS < n ? at + COLUMNS : at;
    else if (e.key === "ArrowUp") next = at - COLUMNS >= 0 ? at - COLUMNS : at;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    buttons[next].focus();
    const id = types[next]?.id;
    if (id && id !== "template") choose(id);
  };
  const description = types.find((x) => x.id === chosen)?.description ?? "";
  return (
    <Modal
      open={open}
      sheet
      onClose={onClose}
      title={t("Neue Seite", "New page")}
      className="np-dialog"
      // The name first, on phones as well.
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        name.current?.focus();
      }}
    >
      <form className="np-form" data-type={chosen} onSubmit={onSubmit} ref={trackSheetHeight}>
        <label className="np-name">
          {t("Name", "Name")}
          <input
            ref={name}
            autoFocus
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            onFocus={(e) => {
              if (titleFromTemplate && !selected.current) e.currentTarget.select();
              selected.current = true;
            }}
            placeholder={t("Wie heißt deine Seite?", "What is your page called?")}
            enterKeyHint="done"
          />
        </label>
        <DuplicateHint workspaceId={boot.workspace.id} title={title} onOpen={onOpenDuplicate} />
        <div className="np-types" role="radiogroup" aria-label={t("Art der Seite", "Kind of page")} aria-describedby="np-desc" ref={tiles} onKeyDown={arrows}>
          {types.map((type) => (
            <button
              key={type.id}
              type="button"
              role="radio"
              aria-checked={chosen === type.id}
              tabIndex={chosen === type.id ? 0 : -1}
              className={`np-type${chosen === type.id ? " chosen" : ""}`}
              data-type={type.id}
              onClick={() => choose(type.id)}
            >
              <type.icon size={22} aria-hidden="true" />
              <span>{type.label}</span>
            </button>
          ))}
        </div>
        <p className="np-desc" id="np-desc" aria-live="polite">
          {description}
        </p>
        {database && (
          <div className="np-options">
            {aiDatabase && (
              <div className="np-row">
                <span className="np-row-label" aria-hidden="true">
                  {t("Anlegen", "Create")}
                </span>
                <div className="segmented np-segmented" role="radiogroup" aria-label={t("Wie anlegen?", "How to create?")}>
                  <label data-active={!aiCreate}>
                    <input type="radio" name="np-ai-create" checked={!aiCreate} onChange={() => onAiCreate(false)} />
                    {t("Vorlage wählen", "Choose a template")}
                  </label>
                  <label data-active={aiCreate}>
                    <input type="radio" name="np-ai-create" checked={aiCreate} onChange={() => onAiCreate(true)} />
                    <Sparkle size={13} aria-hidden="true" />
                    {t("Mit KI erstellen", "Create with AI")}
                  </label>
                </div>
              </div>
            )}
            {aiCreate && aiDatabase ? (
              <AiDatabaseCreator
                workspaceId={boot.workspace.id}
                ai={boot.ai}
                proposal={aiProposal}
                onProposal={onAiProposal}
                onTitle={(proposed) => {
                  if (!title) onTitle(proposed);
                }}
                onError={onError}
              />
            ) : (
              <DatabaseKindPicker
                workspaceId={boot.workspace.id}
                value={databaseChoice}
                onChange={(choice, picked) => {
                  onDatabaseChoice(choice);
                  if (picked) onTemplateTitle(picked.name);
                }}
              />
            )}
          </div>
        )}
        {chosen === "notebook" && (
          <div className="np-options">
            <label className="np-pdf">
              {t("PDF als Notizbuch öffnen (optional)", "Open a PDF as the notebook (optional)")}
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  onNotebookPdf(file);
                  if (file && !title) onTitle(file.name.replace(/\.pdf$/i, ""));
                }}
              />
            </label>
          </div>
        )}
        <label className="np-row np-space">
          <span className="np-row-label">{t("Bereich", "Space")}</span>
          <span className="np-select">
            <Folder size={15} aria-hidden="true" />
            <Select value={spaceId} onChange={(e) => onSpace(e.target.value)}>
              {boot.spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </span>
        </label>
        <div className="modal-actions np-footer">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={database && aiCreate && aiDatabase && (!aiProposal || aiProposal.fields.some((f) => !f.name.trim()))}>
            {t("Seite erstellen", "Create page")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
