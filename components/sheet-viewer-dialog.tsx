"use client";
// The spreadsheet viewer (#402), opened by openSheet() through
// SheetViewerHost (components/sheet-viewer.tsx) and loaded on first use.
// Read-only: the cells come as text from the preview route
// (lib/sheet-preview.ts) – the first 5,000 rows and 200 columns of one
// sheet – and are shown as React text. Sheet tabs, column letters and row
// numbers stay in view while scrolling; the filter and the sort by a column
// only change what is shown, never the file. Only the rows in view (and a
// margin) are rendered, so long sheets scroll smoothly. Column widths and
// the spacers' heights are set from script as CSS custom properties (no
// style attributes, proxy.ts).
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, DownloadSimple, FileCsv, FileXls, Info, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { localeTag } from "@/lib/i18n";
import { columnName, filterRows, sheetKindOf, sheetPreviewUrl, sortRows, type SheetPreview } from "@/lib/sheet-files";
import "@/app/viewer3d.css";
import "@/app/sheet-viewer.css";

type State = { status: "loading" } | { status: "ready"; data: SheetPreview } | { status: "large" | "missing" | "unreadable" | "failed" };

// Must match .sheet-grid's row height in app/sheet-viewer.css.
const ROW = 28;
// Rows rendered above and below those in view.
const MARGIN = 30;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;

// A column's width from its longest text among the first rows: 56–320 px.
function widths(rows: string[][], columns: number) {
  const out = new Array<number>(columns).fill(0);
  for (let r = 0; r < Math.min(rows.length, 400); r++)
    for (let c = 0; c < Math.min(rows[r].length, columns); c++) out[c] = Math.max(out[c], Math.min(rows[r][c].length, 48));
  return out.map((chars) => Math.round(Math.min(320, Math.max(56, chars * 7.4 + 22))));
}

export default function SheetViewerDialog({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const t = useT();
  const locale = localeTag(useLocale());
  const name = title || "CSV";
  const kind = sheetKindOf(name);
  const [sheet, setSheet] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [header, setHeader] = useState(true);
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const dialog = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const [sheets, setSheets] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(sheetPreviewUrl(src, sheet), { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const s = response.status;
          return setState({ status: s === 413 ? "large" : s === 422 ? "unreadable" : [403, 404, 410, 415].includes(s) ? "missing" : "failed" });
        }
        const data = (await response.json()) as SheetPreview;
        setSheets(data.sheets);
        setSort(null);
        setState({ status: "ready", data });
        if (scroller.current) scroller.current.scrollTop = 0;
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      });
    return () => controller.abort();
  }, [src, sheet]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.key !== "Escape") return;
      // Escape in a filled filter empties it first.
      const field = event.target as HTMLInputElement | null;
      if (field?.classList?.contains("sheet-viewer-search") && field.value) return;
      closeRef.current();
    };
    document.addEventListener("keydown", key);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previous;
      opener?.focus?.();
    };
  }, []);

  const data = state.status === "ready" ? state.data : null;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const columns = data?.columns ?? 0;
  const first = header && rows.length > 1 ? 1 : 0;
  // The rows shown, as indices into `rows`: filtered, then sorted.
  const order = useMemo(() => {
    const kept = filterRows(rows, deferred, first);
    return sort ? sortRows(rows, kept, sort.column, sort.descending) : kept;
  }, [rows, deferred, first, sort]);
  const colWidths = useMemo(() => widths(rows, columns), [rows, columns]);

  // The rows in view: from the scroll position, the body's offset (the
  // sticky header rows above it) and the stage's height.
  const head = (first ? 2 : 1) * ROW;
  const start = Math.max(0, Math.floor((view.top - head) / ROW) - MARGIN);
  const end = Math.min(order.length, Math.ceil((view.top + view.height) / ROW) + MARGIN);
  useLayoutEffect(() => {
    const el = table.current;
    if (!el) return;
    el.style.setProperty("--sheet-before", `${start * ROW}px`);
    el.style.setProperty("--sheet-after", `${Math.max(0, order.length - end) * ROW}px`);
    el.style.setProperty("--sheet-width", `${48 + colWidths.reduce((a, b) => a + b, 0)}px`);
  }, [start, end, order.length, colWidths]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", measure);
      resize.disconnect();
    };
  }, [data]);
  // Back to the top when the filter or the sort changes what is shown.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [deferred, sort]);

  const number = (n: number) => n.toLocaleString(locale);
  const cycleSort = (column: number) =>
    setSort((s) => (!s || s.column !== column ? { column, descending: false } : !s.descending ? { column, descending: true } : null));
  const download = (
    <a className="icon-button" href={src} download={name} aria-label={t("Herunterladen", "Download")} title={t("Original herunterladen", "Download the original")}>
      <DownloadSimple size={18} />
    </a>
  );
  const cell = (text: string | undefined, key: number) => (
    <td key={key} className={text && NUMBER.test(text) ? "is-number" : undefined} title={text && text.length > 24 ? text : undefined}>
      {text}
    </td>
  );
  const cells = (count: number, row: string[]) => Array.from({ length: count }, (_, c) => cell(row[c], c));

  return (
    <div className="viewer3d sheet-viewer" role="dialog" aria-modal="true" aria-label={name} ref={dialog} tabIndex={-1}>
      <header className="viewer3d-bar">
        {kind === "csv" ? <FileCsv size={20} aria-hidden /> : <FileXls size={20} aria-hidden />}
        <strong title={name}>{name}</strong>
        <span className="viewer3d-format">{kind === "csv" ? "CSV" : "XLSX"}</span>
        <span className="viewer3d-actions">
          {download}
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      {data && (
        <div className="sheet-viewer-tools">
          <div className="sheet-viewer-filter">
            <MagnifyingGlass size={16} aria-hidden />
            <input
              type="search"
              className="sheet-viewer-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              placeholder={t("Zeilen filtern …", "Filter rows …")}
              aria-label={t("Zeilen filtern", "Filter rows")}
            />
          </div>
          <button type="button" className="viewer3d-tool sheet-viewer-header" aria-pressed={header} onClick={() => setHeader((h) => !h)} title={t("Erste Zeile als Kopfzeile oben halten", "Keep the first row at the top as the header")}>
            {t("Kopfzeile", "Header row")}
          </button>
          <span className="sheet-viewer-count" role="status">
            {deferred.trim()
              ? t(`${number(order.length)} von ${number(rows.length - first)} Zeilen`, `${number(order.length)} of ${number(rows.length - first)} rows`)
              : t(`${number(rows.length - first)} Zeilen`, `${number(rows.length - first)} rows`)}
          </span>
        </div>
      )}
      {data?.truncated && (
        <p className="sheet-viewer-note">
          <Info size={16} aria-hidden />
          <span>
            {t(
              `Gezeigt werden höchstens die ersten ${number(data.limits.rows)} Zeilen und ${number(data.limits.columns)} Spalten – die ganze Tabelle bekommst du mit dem Download.`,
              `Showing at most the first ${number(data.limits.rows)} rows and ${number(data.limits.columns)} columns – download the file for all of it.`,
            )}
          </span>
        </p>
      )}
      <div className="viewer3d-stage sheet-viewer-stage">
        {data && (
          <div className="sheet-viewer-scroll" ref={scroller} tabIndex={0} aria-label={t("Tabelle", "Spreadsheet")}>
            {columns === 0 ? (
              <p className="viewer3d-message">{t("Dieses Blatt ist leer.", "This sheet is empty.")}</p>
            ) : (
              <table className="sheet-grid" ref={table} aria-rowcount={rows.length + 1} aria-colcount={columns + 1}>
                <colgroup>
                  <col className="sheet-col-number" />
                  {colWidths.map((w, c) => (
                    <col key={c} ref={(el) => el?.style.setProperty("--w", `${w}px`)} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="sheet-letters">
                    <th className="sheet-corner" aria-label={t("Zeile", "Row")} />
                    {colWidths.map((_, c) => {
                      const sorted = sort?.column === c ? (sort.descending ? "descending" : "ascending") : undefined;
                      return (
                        <th key={c} aria-sort={sorted ?? "none"}>
                          <button
                            type="button"
                            onClick={() => cycleSort(c)}
                            title={t(`Nach Spalte ${columnName(c)} sortieren (nur die Ansicht)`, `Sort by column ${columnName(c)} (view only)`)}
                          >
                            {columnName(c)}
                            {sorted === "ascending" ? <ArrowUp size={11} weight="bold" aria-hidden /> : sorted === "descending" ? <ArrowDown size={11} weight="bold" aria-hidden /> : null}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                  {first === 1 && (
                    <tr className="sheet-head">
                      <th className="sheet-number" scope="row">
                        1
                      </th>
                      {Array.from({ length: columns }, (_, c) => (
                        <th key={c} scope="col" title={rows[0][c] && rows[0][c].length > 24 ? rows[0][c] : undefined}>
                          {rows[0][c]}
                        </th>
                      ))}
                    </tr>
                  )}
                </thead>
                <tbody>
                  <tr className="sheet-spacer sheet-spacer-before" aria-hidden>
                    <td colSpan={columns + 1} />
                  </tr>
                  {order.slice(start, end).map((index) => (
                    <tr key={index} aria-rowindex={index + 2}>
                      <th className="sheet-number" scope="row">
                        {index + 1}
                      </th>
                      {cells(columns, rows[index])}
                    </tr>
                  ))}
                  <tr className="sheet-spacer sheet-spacer-after" aria-hidden>
                    <td colSpan={columns + 1} />
                  </tr>
                </tbody>
              </table>
            )}
            {columns > 0 && !order.length && (
              <p className="sheet-viewer-empty">
                {deferred.trim() ? t(`Keine Zeile enthält „${deferred.trim()}“.`, `No row contains “${deferred.trim()}”.`) : t("Keine weiteren Zeilen.", "No further rows.")}
              </p>
            )}
          </div>
        )}
        {state.status === "loading" && (
          <p className="viewer3d-message" role="status">
            {t("Vorschau wird geladen …", "Loading preview …")}
          </p>
        )}
        {state.status !== "loading" && state.status !== "ready" && (
          <div className="viewer3d-message is-error sheet-viewer-problem" role="alert">
            <p>
              {state.status === "large"
                ? t("Die Datei ist zu groß für die Vorschau. Du kannst sie herunterladen.", "The file is too large for the preview. You can download it.")
                : state.status === "missing"
                  ? t("Diese Datei ist nicht (mehr) verfügbar.", "This file is not available (any more).")
                  : state.status === "unreadable"
                    ? t("Die Tabelle konnte nicht gelesen werden. Du kannst sie herunterladen.", "The spreadsheet could not be read. You can download it.")
                    : t("Die Vorschau konnte nicht geladen werden.", "The preview could not be loaded.")}
            </p>
            {state.status !== "missing" && (
              <a className="button" href={src} download={name}>
                <DownloadSimple size={16} aria-hidden /> {t("Herunterladen", "Download")}
              </a>
            )}
          </div>
        )}
      </div>
      {sheets.length > 1 && (
        <div className="sheet-tabs" role="tablist" aria-label={t("Tabellenblätter", "Sheets")}>
          {sheets.map((label, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              className="sheet-tab"
              aria-selected={i === sheet}
              onClick={() => setSheet(i)}
            >
              {label || t(`Blatt ${i + 1}`, `Sheet ${i + 1}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
