"use client";
// Own paper templates of notebooks (lib/notebook-library.ts): how one lies
// under the ink of a sheet, and the "Own" section of the paper dialog –
// the workspace's templates, "Add template …" from a picture or a page of
// a PDF (a planner page, a form), renaming and deleting. Choosing one sets
// `paper.image = { template, fit }`; the server copies it onto the page.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api, Modal } from "../ui";
import { PdfBackground } from "./paper";
import { loadPdf } from "../pdf-viewer";
import type { Paper, PaperFit, PaperImage } from "@/lib/notebook-paper";
import { createTemplate, listTemplates, preparePicture, type TemplateEntry } from "./notebook-media";

const fileSrc = (file: string) => `/api/files/${file}`;

// The own template of a sheet over its paper colour, under the ink.
// `src`: another address of the picture (a template not yet on the page,
// in the paper dialog's preview).
export function PaperImageLayer({ image, size, width, eager = false, src }: { image: PaperImage; size: { width: number; height: number }; width: number; eager?: boolean; src?: string }) {
  const url = src || (image.file ? fileSrc(image.file) : null);
  if (!url) return null;
  if (image.kind === "pdf") return <PdfBackground src={url} page={1} width={width} eager={eager} />;
  const tile = image.fit === "tile" && image.width && image.height;
  return (
    <span
      className="notebook-paper-image"
      aria-hidden="true"
      style={{
        backgroundImage: `url("${url}")`,
        backgroundSize: tile ? `${(Math.max(image.width!, size.width / 20) / size.width) * 100}% ${(Math.max(image.height!, size.height / 20) / size.height) * 100}%` : "100% 100%",
        backgroundRepeat: tile ? "repeat" : "no-repeat",
      }}
    />
  );
}

function TemplatePreview({ template }: { template: TemplateEntry }) {
  if (template.kind === "pdf") return <PdfBackground src={template.url} page={1} width={96} />;
  return <img src={template.url} alt="" loading="lazy" />;
}

export function CustomPaperSection({
  pageId,
  draft,
  onChoose,
  onError,
}: {
  pageId: string;
  draft: Paper;
  // The template's entry too when one of the list is chosen (its picture).
  onChoose: (image: PaperImage | null, entry?: TemplateEntry) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [templates, setTemplates] = useState<TemplateEntry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setTemplates(await listTemplates(pageId));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError, pageId]);
  useEffect(() => {
    void load();
  }, [load]);
  const chosen = draft.image?.template || null;
  const rename = async () => {
    const entry = renaming;
    setRenaming(null);
    const name = entry?.name.trim();
    if (!entry || !name || name === templates?.find((x) => x.id === entry.id)?.name) return;
    try {
      await api("/api/command", { action: "notebook.template.update", templateId: entry.id, name });
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const remove = async (template: TemplateEntry) => {
    if (!window.confirm(t(`„${template.name}“ löschen? Blätter mit dieser Vorlage behalten sie.`, `Delete “${template.name}”? Sheets with this template keep it.`))) return;
    try {
      await api("/api/command", { action: "notebook.template.delete", templateId: template.id });
      if (chosen === template.id) onChoose(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <fieldset className="paper-dialog-section notebook-own-paper">
      <legend>{t("Eigene", "Own||paper templates")}</legend>
      <div className="paper-dialog-templates">
        {templates?.map((template) => (
          <label key={template.id} className={`notebook-own-template${chosen === template.id ? " chosen" : ""}`}>
            <input type="radio" name="notebook-template" checked={chosen === template.id} onChange={() => onChoose({ template: template.id, fit: template.fit }, template)} />
            <span className={`paper-dialog-tile${draft.color === "dark" ? " is-dark" : ""}`} style={{ aspectRatio: `${template.width} / ${template.height}` }}>
              <TemplatePreview template={template} />
            </span>
            {renaming?.id === template.id ? (
              <input
                autoFocus
                className="input"
                aria-label={t("Name der Vorlage", "Template name")}
                value={renaming.name}
                maxLength={120}
                onClick={(e) => e.preventDefault()}
                onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.preventDefault(), void rename());
                  if (e.key === "Escape") (e.stopPropagation(), setRenaming(null));
                }}
                onBlur={() => void rename()}
              />
            ) : (
              <span className="paper-dialog-tile-name">{template.name}</span>
            )}
            <span className="paper-dialog-check" aria-hidden="true">
              <Check size={11} weight="bold" />
            </span>
            {template.canEdit && (
              <span className="notebook-own-actions">
                <button type="button" className="icon-button" aria-label={t(`${template.name} umbenennen`, `Rename ${template.name}`)} onClick={(e) => (e.preventDefault(), setRenaming({ id: template.id, name: template.name }))}>
                  <PencilSimple size={13} />
                </button>
                <button type="button" className="icon-button" aria-label={t(`${template.name} löschen`, `Delete ${template.name}`)} onClick={(e) => (e.preventDefault(), void remove(template))}>
                  <Trash size={13} />
                </button>
              </span>
            )}
          </label>
        ))}
        <button type="button" className="notebook-own-add" onClick={() => setAdding(true)}>
          <Plus size={18} />
          <span>{t("Vorlage hinzufügen …", "Add template …")}</span>
        </button>
      </div>
      {draft.image?.template && templates?.find((tpl) => tpl.id === draft.image?.template)?.kind === "image" && (
        <div className="notebook-own-fit" role="radiogroup" aria-label={t("Anordnung", "Layout||paper template")}>
          {(["stretch", "tile"] as PaperFit[]).map((fit) => (
            <label key={fit}>
              <input type="radio" name="notebook-own-fit" checked={(draft.image?.fit || "stretch") === fit} onChange={() => onChoose({ ...draft.image!, fit }, templates?.find((tpl) => tpl.id === draft.image?.template))} />
              {fit === "stretch" ? t("Auf das Blatt strecken", "Stretch to the sheet") : t("Kacheln", "Tile")}
            </label>
          ))}
        </div>
      )}
      <AddTemplateDialog
        open={adding}
        pageId={pageId}
        onClose={() => setAdding(false)}
        onError={onError}
        onAdded={(template) => {
          setAdding(false);
          setTemplates((list) => [...(list || []), template]);
          onChoose({ template: template.id, fit: template.fit }, template);
        }}
      />
    </fieldset>
  );
}

// A picture or a PDF page as a new template of the workspace.
function AddTemplateDialog({ open, pageId, onClose, onAdded, onError }: { open: boolean; pageId: string; onClose: () => void; onAdded: (template: TemplateEntry) => void; onError: (message: string) => void }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [name, setName] = useState("");
  const [fit, setFit] = useState<PaperFit>("stretch");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pdf = !!file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
  useEffect(() => {
    if (!open) {
      setFile(null);
      setPages(0);
      setPage(1);
      setName("");
      setFit("stretch");
    }
  }, [open]);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    if (pdf)
      loadPdf(url)
        .then((doc) => setPages(doc.numPages))
        .catch(() => setPages(0));
    return () => URL.revokeObjectURL(url);
  }, [file, pdf]);
  const save = async () => {
    if (!file) return;
    setBusy(true);
    try {
      // Pictures as shown (camera orientation applied, no EXIF data).
      const upload = pdf ? file : (await preparePicture(file)).file;
      onAdded(await createTemplate(pageId, upload, { name: name.trim() || file.name.replace(/\.[^.]+$/, ""), fit: pdf ? "stretch" : fit, pdfPage: pdf ? page : undefined }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Papiervorlage hinzufügen", "Add paper template")} className="notebook-template-dialog">
      <div className="notebook-paper-form">
        <p>
          {t(
            "Ein Bild oder eine PDF-Seite (z. B. eine Planerseite) wird Papier für Blätter. Alle im Arbeitsbereich können die Vorlage nutzen; wer sie anlegt, kann sie umbenennen und löschen.",
            "A picture or a PDF page (a planner page, say) becomes paper for sheets. Everyone in the workspace can use the template; whoever adds it can rename and delete it.",
          )}
        </p>
        <button type="button" className="button" onClick={() => input.current?.click()}>
          {file ? file.name : t("Bild oder PDF wählen …", "Choose picture or PDF …")}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0] || null;
            e.target.value = "";
            setFile(chosen);
            setPage(1);
            if (chosen && !name) setName(chosen.name.replace(/\.[^.]+$/, "").slice(0, 120));
          }}
        />
        {preview && (
          <div className="notebook-template-chosen">
            {pdf ? <PdfBackground src={preview} page={page} width={160} eager /> : <img src={preview} alt="" />}
          </div>
        )}
        {pdf && pages > 1 && (
          <label>
            {t("Seite", "Page")}
            <input className="input" type="number" min={1} max={pages} value={page} onChange={(e) => setPage(Math.max(1, Math.min(pages, Number(e.target.value) || 1)))} />
            <span className="notebook-insert-hint">{t(`von ${pages}`, `of ${pages}`)}</span>
          </label>
        )}
        <label>
          {t("Name", "Name")}
          <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        {file && !pdf && (
          <fieldset>
            <legend>{t("Anordnung", "Layout||paper template")}</legend>
            <label>
              <input type="radio" name="notebook-new-fit" checked={fit === "stretch"} onChange={() => setFit("stretch")} />
              {t("Auf das Blatt strecken", "Stretch to the sheet")}
            </label>
            <label>
              <input type="radio" name="notebook-new-fit" checked={fit === "tile"} onChange={() => setFit("tile")} />
              {t("Kacheln (Muster)", "Tile (pattern)")}
            </label>
          </fieldset>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button primary" disabled={!file || busy} onClick={() => void save()}>
            {busy ? t("Wird hochgeladen …", "Uploading …") : t("Hinzufügen", "Add")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
