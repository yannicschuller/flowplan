"use client";
// Export menus for databases and single records: CSV of the current view,
// Markdown (with frontmatter) as one file or as a ZIP with files, and for a
// record also Print / PDF.
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { DotsThree, DownloadSimple, FileCsv, FileText, FileZip, NotePencil, Printer } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { flushOpenDocuments } from "@/lib/document-flush";
import { exportName } from "@/lib/export-name";
import { useT } from "./i18n";
import { downloadBlob } from "./ui";
import { printPage } from "./print-page";

export async function downloadMarkdown(pageId: string, title: string, format: "markdown" | "zip", rowId?: string) {
  await flushOpenDocuments();
  const response = await fetch("/api/markdown-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId, format, includeSubpages: false, ...(rowId ? { rowId } : {}) }),
  });
  if (!response.ok) throw new Error(serverMessage((await response.json().catch(() => ({}))).error) || "Export failed.");
  downloadBlob(`${exportName(title)}.${format === "zip" ? "zip" : "md"}`, await response.blob());
}

// The database toolbar: one "Export" menu instead of a lone CSV button.
export function DatabaseExportMenu({
  pageId,
  title,
  onCsv,
  onError,
}: {
  pageId: string;
  title: string;
  onCsv: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const run = (format: "markdown" | "zip") => () => void downloadMarkdown(pageId, title, format).catch((e) => onError((e as Error).message));
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button title={t("Exportieren", "Export")} aria-label={t("Exportieren", "Export")}>
          <DownloadSimple size={17} />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="dropdown" align="end" sideOffset={4}>
          <Dropdown.Item className="dropdown-item" onSelect={onCsv}>
            <FileCsv />
            {t("CSV (aktuelle Ansicht)", "CSV (current view)")}
          </Dropdown.Item>
          <Dropdown.Item className="dropdown-item" onSelect={run("zip")}>
            <FileZip />
            {t("Markdown mit Dateien (.zip)", "Markdown with files (.zip)")}
          </Dropdown.Item>
          <Dropdown.Item className="dropdown-item" onSelect={run("markdown")}>
            <FileText />
            Markdown (.md)
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

// The record header: export one record or print it, or turn it into a page.
export function RecordExportMenu({
  pageId,
  rowId,
  title,
  printRoot,
  onError,
  onToPage,
}: {
  pageId: string;
  rowId: string;
  title: string;
  printRoot: () => HTMLElement | null;
  onError: (message: string) => void;
  onToPage?: () => void;
}) {
  const t = useT();
  const run = (format: "markdown" | "zip") => () =>
    void downloadMarkdown(pageId, title, format, rowId).catch((e) => onError((e as Error).message));
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className="icon-button" aria-label={t("Weitere Aktionen", "More actions")} title={t("Weitere Aktionen", "More actions")}>
          <DotsThree size={17} />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="dropdown" align="end" sideOffset={4}>
          <Dropdown.Item className="dropdown-item" onSelect={run("markdown")}>
            <FileText />
            {t("Als Markdown exportieren (.md)", "Export as Markdown (.md)")}
          </Dropdown.Item>
          <Dropdown.Item className="dropdown-item" onSelect={run("zip")}>
            <FileZip />
            {t("Markdown mit Dateien (.zip)", "Markdown with files (.zip)")}
          </Dropdown.Item>
          <Dropdown.Item className="dropdown-item" onSelect={() => printPage(printRoot() || undefined)}>
            <Printer />
            {t("Drucken / PDF", "Print / PDF")}
          </Dropdown.Item>
          {onToPage && (
            <>
              <Dropdown.Separator className="dropdown-separator" />
              <Dropdown.Item className="dropdown-item" onSelect={onToPage}>
                <NotePencil />
                {t("In Seite umwandeln …", "Turn into page …")}
              </Dropdown.Item>
            </>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
