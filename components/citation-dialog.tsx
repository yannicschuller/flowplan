"use client";
// "/zitat": choose a work from the workspace's bibliography, resolve a DOI
// or import BibTeX / CSL-JSON (e.g. a Zotero export) – then cite it.
import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlass, UploadSimple } from "@phosphor-icons/react";
import { Modal, api } from "./ui";
import { useT } from "./i18n";
import { serverMessage } from "@/lib/i18n-errors";
import { inlineCitation, normalizeDoi, referenceText, type CslItem } from "@/lib/citations";

export function CitationDialog({
  open,
  workspaceId,
  onClose,
  onCloseAutoFocus,
  onInsert,
  onError,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  // Where the focus goes after closing (the editor's caret).
  onCloseAutoFocus?: (event: Event) => void;
  onInsert: (item: CslItem, locator: string) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<CslItem[]>([]),
    [query, setQuery] = useState(""),
    [locator, setLocator] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [importing, setImporting] = useState(false),
    [bibtex, setBibtex] = useState(""),
    [status, setStatus] = useState("");
  async function load() {
    try {
      const data = await api<{ items: CslItem[] }>(`/api/citations?workspace=${workspaceId}`);
      setItems(data.items);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setLocator("");
    setStatus("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId]);
  const doi = normalizeDoi(query);
  const shown = useMemo(() => {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return items
      .filter((item) => {
        const haystack = [item.id, item.title, item.DOI, ...(item.author || item.editor || []).map((n) => n.family || n.literal), item.issued?.["date-parts"]?.[0]?.[0]]
          .join(" ")
          .toLocaleLowerCase();
        return words.every((w) => haystack.includes(w));
      })
      .slice(0, 100);
  }, [items, query]);
  function choose(item: CslItem) {
    onInsert(item, locator.trim());
    onClose();
  }
  async function resolve() {
    if (!doi) return;
    setBusy(true);
    try {
      const data = await api<{ item: CslItem }>("/api/citations/doi", { workspaceId, doi });
      choose(data.item);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importText(text: string) {
    setBusy(true);
    setStatus("");
    try {
      const result = await api<{ added: number; updated: number }>("/api/command", {
        action: "citation.import",
        workspaceId,
        text,
      });
      setStatus(t(`${result.added} neu, ${result.updated} aktualisiert.`, `${result.added} new, ${result.updated} updated.`));
      setBibtex("");
      setImporting(false);
      await load();
    } catch (e) {
      onError(serverMessage((e as Error).message) || (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} onCloseAutoFocus={onCloseAutoFocus} title={t("Literatur zitieren", "Cite a source")} wide>
      <div className="citation-dialog">
        <label className="citation-search">
          <MagnifyingGlass size={16} aria-hidden />
          <input
            autoFocus
            value={query}
            placeholder={t("Suchen oder DOI einfügen (z. B. 10.1000/xyz123) …", "Search or paste a DOI (e.g. 10.1000/xyz123) …")}
            aria-label={t("Literatur suchen oder DOI", "Search sources or DOI")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (doi) void resolve();
              else if (shown[0]) choose(shown[0]);
            }}
          />
        </label>
        <label className="citation-locator">
          {t("Seite / Stelle (optional)", "Page / location (optional)")}
          <input value={locator} maxLength={100} placeholder="12–14" onChange={(e) => setLocator(e.target.value)} />
        </label>
        {doi && (
          <button className="button primary" disabled={busy} onClick={() => void resolve()}>
            {busy ? t("DOI wird aufgelöst …", "Resolving DOI …") : t(`DOI ${doi} auflösen und zitieren`, `Resolve and cite DOI ${doi}`)}
          </button>
        )}
        <ul className="citation-results" aria-label={t("Literaturliste", "Bibliography")}>
          {shown.map((item) => (
            <li key={item.id}>
              <button onClick={() => choose(item)} title={item.id}>
                <strong>{inlineCitation(item, "", t)}</strong>
                <span>{referenceText(item, t)}</span>
              </button>
            </li>
          ))}
          {loaded && !shown.length && !doi && (
            <li className="muted">
              {items.length
                ? t("Nichts gefunden.", "Nothing found.")
                : t("Die Literaturliste dieses Arbeitsbereichs ist noch leer. DOI einfügen oder BibTeX/CSL-JSON importieren.", "This workspace's bibliography is still empty. Paste a DOI or import BibTeX/CSL-JSON.")}
            </li>
          )}
        </ul>
        {importing ? (
          <div className="citation-import">
            <textarea
              rows={6}
              value={bibtex}
              placeholder={"@article{mueller2021,\n  author = {Müller, Anna},\n  title = {…},\n  year = {2021}\n}"}
              aria-label={t("BibTeX oder CSL-JSON", "BibTeX or CSL-JSON")}
              onChange={(e) => setBibtex(e.target.value)}
            />
            <div className="modal-actions">
              <label className="button file-label">
                <UploadSimple /> {t("Datei wählen (.bib, .json)", "Choose file (.bib, .json)")}
                <input
                  type="file"
                  hidden
                  accept=".bib,.bibtex,.json,application/json,application/x-bibtex,text/plain"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    if (file.size > 5 * 1024 * 1024) return onError(t("Die Datei ist zu groß (höchstens 5 MB).", "The file is too large (at most 5 MB)."));
                    await importText(await file.text());
                  }}
                />
              </label>
              <button className="button primary" disabled={busy || !bibtex.trim()} onClick={() => void importText(bibtex)}>
                {t("Importieren", "Import")}
              </button>
            </div>
          </div>
        ) : (
          <button className="button" onClick={() => setImporting(true)}>
            {t("BibTeX oder CSL-JSON importieren (Zotero) …", "Import BibTeX or CSL-JSON (Zotero) …")}
          </button>
        )}
        {status && <p role="status">{status}</p>}
      </div>
    </Modal>
  );
}
