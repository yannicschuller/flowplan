"use client";
// "Karten importieren" (docs/specs/flashcards.md §8.3): text pasted or a
// file (CSV, TSV, Quizlet's export) becomes records of the deck. The
// separators are detected and can be changed, each column goes to a
// property (the deck's sides suggested by the header or the order), a
// preview shows the first cards and every line that cannot become one, and
// the records are created through rows.import – the database's own import,
// which checks each value on the server – in batches of 1000.
import { useEffect, useMemo, useState } from "react";
import { FileArrowUp, Warning } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { Select } from "../select";
import { browserZone } from "@/lib/date-values";
import { toPlain } from "@/lib/inline-markdown";
import {
  IMPORTABLE,
  IMPORT_BATCH,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_CARDS,
  detectDelimiters,
  looksLikeHeader,
  planImport,
  roleFields,
  splitRows,
  suggestMapping,
  type Delimiters,
} from "@/lib/study-import";
import type { StudySettings } from "@/lib/study-schema";
import type { Database } from "@/lib/types";

const COLUMN = [
  ["\t", "tab"],
  [",", "comma"],
  [";", "semicolon"],
] as const;
const ROW = [
  ["\n", "line"],
  [";", "semicolon"],
] as const;

export function StudyImport({
  open,
  onClose,
  database,
  settings,
  act,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  database: Database;
  settings: StudySettings;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onDone: (count: number) => void;
}) {
  const t = useT();
  const [text, setText] = useState(""),
    [delimiters, setDelimiters] = useState<Delimiters>({ column: "\t", row: "\n" }),
    [custom, setCustom] = useState({ column: "", row: "" }),
    [header, setHeader] = useState(false),
    [mapping, setMapping] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setText("");
    setError("");
    setProgress(0);
  }, [open]);
  const fields = database.fields.filter((f) => IMPORTABLE.has(f.type));
  const column = delimiters.column === "custom" ? custom.column : delimiters.column;
  const row = delimiters.row === "custom" ? custom.row || "\n" : delimiters.row;
  const rows = useMemo(() => (text.trim() && column ? splitRows(text, { column, row }) : []), [text, column, row]);
  const columns = rows.reduce((n, r) => Math.max(n, r.length), 0);
  // New text: separators, header and mapping suggested again.
  const take = (value: string) => {
    setText(value);
    if (!value.trim()) return;
    const found = detectDelimiters(value);
    setDelimiters(found);
    const parsed = splitRows(value, found);
    const first = parsed[0] || [];
    const isHeader = looksLikeHeader(first, settings, database.fields);
    setHeader(isHeader);
    setMapping(suggestMapping(parsed.reduce((n, r) => Math.max(n, r.length), 0), isHeader ? first : null, settings, database.fields));
  };
  // A changed separator or header keeps the mapping where it fits.
  useEffect(() => {
    setMapping((m) => (m.length === columns ? m : suggestMapping(columns, header ? rows[0] || [] : null, settings, database.fields)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, header]);
  const plan = useMemo(() => planImport(rows, mapping, header, settings, database.fields, t), [rows, mapping, header, settings, database.fields, t]);
  const roles = new Map(roleFields(settings, database.fields).filter((r): r is [typeof r[0], string] => !!r[1]).map(([role, id]) => [id, role]));
  const roleName: Record<string, string> = {
    front: t("Vorderseite", "Front"),
    back: t("Rückseite", "Back"),
    hint: t("Hinweis", "Hint"),
    extra: t("Zusatz", "Extra"),
    tags: "Tags",
    type: t("Kartentyp", "Card type"),
    choices: t("Antwortoptionen", "Answer options"),
  };
  const sideField = (s: StudySettings["front"] | StudySettings["back"]) => ("field" in s ? s.field : null);
  const front = sideField(settings.front),
    back = sideField(settings.back);
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      let done = 0;
      for (let i = 0; i < plan.records.length; i += IMPORT_BATCH) {
        const result = await act({ action: "rows.import", rows: plan.records.slice(i, i + IMPORT_BATCH), timeZone: browserZone() });
        if (!result) throw new Error(t("Der Import wurde abgebrochen.", "The import was stopped."));
        done += Math.min(IMPORT_BATCH, plan.records.length - i);
        setProgress(done);
      }
      onDone(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const preview = plan.records.slice(0, 5);
  const cell = (cells: Record<string, unknown>, id: string | null) => {
    if (!id) return "";
    const value = cells[id];
    return Array.isArray(value) ? value.join(", ") : toPlain(String(value ?? ""));
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Karten importieren", "Import cards")} wide sheet className="study-import">
      <div className="study-import-body">
        <p className="muted">
          {t(
            "Füge Text ein oder wähle eine Datei: CSV, TSV oder den Export aus Quizlet („Exportieren“ – Begriff und Definition mit Tab, Karten mit neuer Zeile oder Semikolon getrennt). Bilder aus Quizlet kommen so nicht mit.",
            "Paste text or choose a file: CSV, TSV or Quizlet's export (“Export” – term and definition separated by a tab, cards by a new line or a semicolon). Images from Quizlet do not come along this way.",
          )}
        </p>
        <label className="study-import-text">
          {t("Text", "Text")}
          <textarea
            value={text}
            rows={7}
            spellCheck={false}
            placeholder={t("hola\thallo\nperro\tHund", "hola\thello\nperro\tdog")}
            onChange={(e) => take(e.target.value)}
          />
        </label>
        <label className="button compact study-import-file">
          <FileArrowUp aria-hidden /> {t("Datei wählen …", "Choose a file …")}
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              if (file.size > MAX_IMPORT_BYTES) {
                setError(t(`Die Datei ist größer als ${MAX_IMPORT_BYTES / 1_000_000} MB.`, `The file is larger than ${MAX_IMPORT_BYTES / 1_000_000} MB.`));
                return;
              }
              take(await file.text());
            }}
          />
        </label>
        <div className="form-row study-import-delimiters">
          <label>
            {t("Zwischen Begriff und Definition", "Between term and definition")}
            <Select value={COLUMN.some(([c]) => c === delimiters.column) ? delimiters.column : "custom"} onChange={(e) => setDelimiters({ ...delimiters, column: e.target.value })}>
              <option value={"\t"}>{t("Tab", "Tab")}</option>
              <option value=",">{t("Komma", "Comma")}</option>
              <option value=";">{t("Semikolon", "Semicolon")}</option>
              <option value="custom">{t("Eigenes …", "Custom …")}</option>
            </Select>
          </label>
          {delimiters.column === "custom" && (
            <label>
              {t("Eigenes Trennzeichen", "Custom separator")}
              <input value={custom.column} maxLength={5} onChange={(e) => setCustom({ ...custom, column: e.target.value })} />
            </label>
          )}
          <label>
            {t("Zwischen Karten", "Between cards")}
            <Select value={ROW.some(([r]) => r === delimiters.row) ? delimiters.row : "custom"} onChange={(e) => setDelimiters({ ...delimiters, row: e.target.value })}>
              <option value={"\n"}>{t("Neue Zeile", "New line")}</option>
              <option value=";">{t("Semikolon", "Semicolon")}</option>
              <option value="custom">{t("Eigenes …", "Custom …")}</option>
            </Select>
          </label>
          {delimiters.row === "custom" && (
            <label>
              {t("Eigenes Trennzeichen", "Custom separator")}
              <input value={custom.row} maxLength={5} onChange={(e) => setCustom({ ...custom, row: e.target.value })} />
            </label>
          )}
        </div>
        {rows.length > 0 && (
          <>
            <label className="checkbox-label">
              <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
              {t("Erste Zeile benennt die Spalten", "The first line names the columns")}
            </label>
            <div className="study-import-mapping" role="group" aria-label={t("Spalten zuordnen", "Map the columns")}>
              {Array.from({ length: columns }, (_, i) => {
                const name = header ? rows[0]?.[i] || t(`Spalte ${i + 1}`, `Column ${i + 1}`) : t(`Spalte ${i + 1}`, `Column ${i + 1}`);
                const sample = rows[header ? 1 : 0]?.[i] || "";
                return (
                  <label key={i}>
                    <span className="study-import-column">
                      {name}
                      {sample && <small>{sample.slice(0, 60)}</small>}
                    </span>
                    <Select
                      aria-label={t(`Ziel für ${name}`, `Target for ${name}`)}
                      value={mapping[i] || ""}
                      onChange={(e) => setMapping(Array.from({ length: columns }, (_, j) => (j === i ? e.target.value : mapping[j] === e.target.value ? "" : mapping[j] || "")))}
                    >
                      <option value="">{t("— nicht übernehmen —", "— skip —")}</option>
                      {fields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                          {roles.get(f.id) ? ` (${roleName[roles.get(f.id)!]})` : ""}
                        </option>
                      ))}
                    </Select>
                  </label>
                );
              })}
            </div>
            {preview.length > 0 && (
              <div className="study-import-preview">
                <h4>{t("Vorschau", "Preview")}</h4>
                <ol>
                  {preview.map((cells, i) => (
                    <li key={i}>
                      <span>{cell(cells, front) || cell(cells, mapping.find(Boolean) || null)}</span>
                      {back && cell(cells, back) && (
                        <>
                          <span aria-hidden> → </span>
                          <span>{cell(cells, back)}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {(!front || !back) && (
              <p className="muted">
                {t(
                  "Eine Kartenseite kommt aus dem Dokument der Einträge – dorthin importiert der Assistent nicht. Ordne die Spalten Eigenschaften zu.",
                  "A side of the cards comes from the records' document – the wizard does not import into it. Map the columns to properties.",
                )}
              </p>
            )}
            {(plan.errors.length > 0 || plan.duplicates > 0) && (
              <div className="study-import-errors" role="status">
                {plan.errors.length > 0 && (
                  <>
                    <p>
                      <Warning aria-hidden /> {plan.errors.length === 1 ? t("1 Zeile wird nicht importiert:", "1 line is not imported:") : t(`${plan.errors.length} Zeilen werden nicht importiert:`, `${plan.errors.length} lines are not imported:`)}
                    </p>
                    <ul>
                      {plan.errors.slice(0, 20).map((e) => (
                        <li key={e.line}>{t(`Zeile ${e.line}: ${e.message}`, `Line ${e.line}: ${e.message}`)}</li>
                      ))}
                    </ul>
                    {plan.errors.length > 20 && <p className="muted">{t(`und ${plan.errors.length - 20} weitere`, `and ${plan.errors.length - 20} more`)}</p>}
                  </>
                )}
                {plan.duplicates > 0 && <p className="muted">{t(`${plan.duplicates} doppelte Zeilen übersprungen.`, `${plan.duplicates} duplicate lines skipped.`)}</p>}
              </div>
            )}
          </>
        )}
        {error && (
          <p className="study-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">{t(`Höchstens ${MAX_IMPORT_CARDS} Zeilen auf einmal.`, `At most ${MAX_IMPORT_CARDS} lines at once.`)}</p>
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose} disabled={busy}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button type="button" className="button primary" disabled={busy || !plan.records.length} onClick={() => void run()}>
          {busy
            ? t(`Importiere … ${progress}/${plan.records.length}`, `Importing … ${progress}/${plan.records.length}`)
            : plan.records.length === 1
              ? t("1 Karte importieren", "Import 1 card")
              : t(`${plan.records.length} Karten importieren`, `Import ${plan.records.length} cards`)}
        </button>
      </div>
    </Modal>
  );
}
