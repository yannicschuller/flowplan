"use client";
// The document exports (app/api/export/*): a Word file or e-book to
// download, the combined print view handed to the print dialog.
import { serverMessage } from "@/lib/i18n-errors";
import { flushOpenDocuments } from "@/lib/document-flush";
import { tr } from "@/lib/locale-tag";
import { downloadBlob } from "./ui";
import { printDocument } from "./print-page";
import { printOptionsQuery, type PrintOptions } from "@/lib/print-options";

async function fetchExport(url: string) {
  await flushOpenDocuments();
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(serverMessage(body.error) || tr("Export fehlgeschlagen.", "Export failed."));
  }
  return response;
}
// The file name comes from the server (Content-Disposition), the caller's
// name is the fallback.
export async function downloadExport(url: string, fallbackName: string) {
  const response = await fetchExport(url);
  const match = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("Content-Disposition") || "");
  let name = fallbackName;
  if (match)
    try {
      name = decodeURIComponent(match[1]);
    } catch {}
  downloadBlob(name, await response.blob());
}
// The combined print view: fetched with the session, then printed – with
// the print options (#215) in the query.
export async function printExport(url: string, options?: PrintOptions) {
  const query = options ? printOptionsQuery(options) : "";
  const response = await fetchExport(query ? `${url}&print=${encodeURIComponent(query)}` : url);
  printDocument(await response.text());
}
export const docxUrl = (pageId: string, rowId?: string) => `/api/export/docx?page=${pageId}${rowId ? `&row=${rowId}` : ""}`;
export const pdfUrl = (target: { pageId: string; children: boolean } | { spaceId: string }) =>
  "spaceId" in target ? `/api/export/pdf?space=${target.spaceId}` : `/api/export/pdf?page=${target.pageId}${target.children ? "&children=1" : ""}`;
export const epubUrl = (target: { pageId: string; children: boolean } | { spaceId: string }) =>
  "spaceId" in target ? `/api/export/epub?space=${target.spaceId}` : `/api/export/epub?page=${target.pageId}${target.children ? "&children=1" : ""}`;
// Jira wiki markup and Confluence storage format of a page or record (#221).
export const textExportUrl = (format: "jira" | "confluence", pageId: string, rowId?: string) =>
  `/api/export/${format}?page=${pageId}${rowId ? `&row=${rowId}` : ""}`;
// A text export as text, for the clipboard.
export async function exportText(url: string) {
  return await (await fetchExport(url)).text();
}
