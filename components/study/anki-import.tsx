"use client";
// "Aus Anki importieren" (docs/specs/flashcards.md §8.1): an Anki package
// (.apkg, .colpkg) becomes one flashcard database per top-level deck. The
// file goes up once (lib/importers/upload.ts, a background job with
// progress, components/import-client.ts); the preview shows decks, notes,
// media and per note type what its fields become – card type, reverse card
// and each field's side, as suggested by the server from Anki's templates –
// and the import then uses the kept upload with the mapping chosen here.
// Optionally the person's own learning state comes along (Anki's review log
// replayed through FSRS, for them only).
import { useEffect, useMemo, useRef, useState } from "react";
import { FileArrowUp, Warning } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { Select } from "../select";
import { sendImport, waitForJob, warningText } from "../import-client";
import { browserZone } from "@/lib/date-values";
import { ANKI_ROLES, type AnkiCardType, type AnkiPreview, type AnkiRole, type NotetypeMapping } from "@/lib/anki-mapping";
import type { Space } from "@/lib/types";

type Preview = { warnings: string[]; files: number; bytes: number; upload?: string; anki: AnkiPreview };
type Outcome = { rootIds: string[]; rows: number; reviews?: number; report?: { pageId: string; total: number } };

const mb = (bytes: number) => (bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 });

export function StudyAnkiImport({
  open,
  onClose,
  workspaceId,
  spaces,
  spaceId,
  onOpenPage,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  spaces: Pick<Space, "id" | "name">[];
  // A fixed target space (the import settings choose it themselves).
  spaceId?: string;
  onOpenPage?: (pageId: string) => void;
}) {
  const t = useT();
  const [space, setSpace] = useState(spaceId || spaces[0]?.id || ""),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [mapping, setMapping] = useState<Record<string, NotetypeMapping>>({}),
    [state, setState] = useState(false),
    [progress, setProgress] = useState<{ phase: "upload" | "work"; share: number | null } | null>(null),
    [error, setError] = useState(""),
    [done, setDone] = useState<Outcome | null>(null);
  const upload = useRef<string | undefined>(undefined);
  const discard = () => {
    if (upload.current) void sendImport(new URLSearchParams({ upload: upload.current, discard: "1" }), null, () => {}).catch(() => {});
    upload.current = undefined;
  };
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPreview(null);
    setMapping({});
    setState(false);
    setError("");
    setDone(null);
    setSpace(spaceId || spaces[0]?.id || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const close = () => {
    if (!done) discard();
    onClose();
  };
  const run = async (query: URLSearchParams, body: File | null) => {
    query.set("background", "1");
    setProgress(body ? { phase: "upload", share: 0 } : { phase: "work", share: null });
    try {
      const { job } = (await sendImport(query, body, (share) => setProgress(share >= 1 ? { phase: "work", share: null } : { phase: "upload", share }))) as { job: string };
      setProgress({ phase: "work", share: null });
      return await waitForJob(job, (share) => setProgress({ phase: "work", share }));
    } finally {
      setProgress(null);
    }
  };
  const check = async (chosen: File) => {
    discard();
    setFile(chosen);
    setPreview(null);
    setError("");
    try {
      const result = (await run(new URLSearchParams({ workspaceId, spaceId: space, source: "anki", name: chosen.name, dryRun: "1" }), chosen)) as Preview;
      upload.current = result.upload;
      setPreview(result);
      setMapping(Object.fromEntries(result.anki.notetypes.map((n) => [n.id, n.mapping])));
    } catch (e) {
      setError((e as Error).message === "network" ? t("Keine Verbindung zum Server.", "No connection to the server.") : (e as Error).message);
    }
  };
  const start = async () => {
    if (!preview || !file) return;
    setError("");
    try {
      const query = new URLSearchParams({ workspaceId, spaceId: space, source: "anki", name: file.name, anki: JSON.stringify({ notetypes: mapping, state }), zone: browserZone() });
      if (upload.current) query.set("upload", upload.current);
      const result = (await run(query, upload.current ? null : file)) as Outcome;
      upload.current = undefined;
      setDone(result);
    } catch (e) {
      setError((e as Error).message === "network" ? t("Keine Verbindung zum Server.", "No connection to the server.") : (e as Error).message);
    }
  };
  const busy = !!progress;
  const roleNames: Record<AnkiRole, string> = {
    front: t("Vorderseite", "Front"),
    back: t("Rückseite", "Back"),
    hint: t("Hinweis", "Hint"),
    extra: t("Zusatz (nach dem Aufdecken)", "Extra (after revealing)"),
    skip: t("— nicht übernehmen —", "— skip —"),
  };
  const kindNames: Record<string, string> = {
    basic: t("Vorder-/Rückseite", "Front/back"),
    reversed: t("mit Rückwärtskarte", "with reverse card"),
    optional: t("Rückwärtskarte optional", "optional reverse card"),
    typed: t("Antwort eintippen", "Type the answer"),
    cloze: t("Lückentext", "Cloze"),
    occlusion: t("Bildverdeckung", "Image occlusion"),
    custom: t("eigener Notiztyp", "own note type"),
  };
  const anki = preview?.anki;
  const cards = useMemo(() => anki?.decks.reduce((n, d) => n + d.notes, 0) || 0, [anki]);
  return (
    <Modal open={open} onClose={close} title={t("Aus Anki importieren", "Import from Anki")} wide sheet className="study-import study-anki-import">
      <div className="study-import-body">
        {done ? (
          <div className="study-anki-done" role="status">
            <p>
              {t(
                `${done.rows} Notizen in ${done.rootIds.length} ${done.rootIds.length === 1 ? "Stapel" : "Stapeln"} importiert.`,
                `${done.rows} notes imported into ${done.rootIds.length} ${done.rootIds.length === 1 ? "deck" : "decks"}.`,
              )}
              {done.reviews !== undefined && ` ${t(`${done.reviews} Wiederholungen als dein Lernstand übernommen.`, `${done.reviews} reviews taken over as your learning state.`)}`}
            </p>
            {done.report && onOpenPage && (
              <button type="button" className="button compact" onClick={() => onOpenPage(done.report!.pageId)}>
                {t(`${done.report.total} Hinweise im Importbericht`, `${done.report.total} notes in the import report`)}
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="muted">
              {t(
                "Exportiere in Anki einen Stapel („Datei → Exportieren …“, Format „Anki-Stapelpaket (.apkg)“) oder die ganze Sammlung (.colpkg). Jeder oberste Stapel wird eine Lernkarten-Datenbank, Unterstapel kommen in die Eigenschaft „Deck“. Bilder und Töne kommen mit.",
                "In Anki, export a deck (“File → Export …”, format “Anki Deck Package (.apkg)”) or the whole collection (.colpkg). Every top-level deck becomes a flashcard database, sub-decks go into the property “Deck”. Images and sounds come along.",
              )}
            </p>
            <div className="form-row study-anki-file">
              {spaceId === undefined && spaces.length > 1 && (
                <label>
                  {t("Zielbereich", "Target space")}
                  <Select value={space} onChange={(e) => setSpace(e.target.value)} disabled={busy || !!preview}>
                    {spaces.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <label className={`button compact study-import-file${busy ? " disabled" : ""}`}>
                <FileArrowUp aria-hidden /> {file ? t("Andere Datei wählen …", "Choose another file …") : t("Anki-Datei wählen …", "Choose an Anki file …")}
                <input
                  type="file"
                  accept=".apkg,.colpkg"
                  className="sr-only"
                  disabled={busy}
                  aria-label={t("Anki-Datei", "Anki file")}
                  onChange={(e) => {
                    const chosen = e.target.files?.[0];
                    e.target.value = "";
                    if (chosen) void check(chosen);
                  }}
                />
              </label>
              {file && <span className="muted study-anki-name">{file.name}</span>}
            </div>
          </>
        )}
        {progress && (
          <p className="muted" role="status" aria-live="polite">
            {progress.phase === "upload"
              ? t(`Wird hochgeladen … ${Math.round((progress.share || 0) * 100)} %`, `Uploading … ${Math.round((progress.share || 0) * 100)} %`)
              : progress.share !== null
                ? t(`Wird verarbeitet … ${Math.round(progress.share * 100)} %`, `Processing … ${Math.round(progress.share * 100)} %`)
                : t("Wird verarbeitet …", "Processing …")}
          </p>
        )}
        {anki && !done && (
          <>
            <section className="study-anki-summary" aria-label={t("Inhalt des Pakets", "Contents of the package")}>
              <p>
                {t(`${anki.notes} Notizen · ${anki.cards} Karten in Anki`, `${anki.notes} notes · ${anki.cards} cards in Anki`)}
                {anki.media.files > 0 && ` · ${t(`${anki.media.files} Mediendateien (${mb(anki.media.bytes)} MB)`, `${anki.media.files} media files (${mb(anki.media.bytes)} MB)`)}`}
              </p>
              <ul className="study-anki-decks">
                {anki.decks.map((d) => (
                  <li key={d.name}>
                    <strong>{d.name}</strong> · {t(`${d.notes} Notizen`, `${d.notes} notes`)}
                    {d.subdecks.length > 0 && <span className="muted"> · {t(`Unterstapel: ${d.subdecks.join(", ")}`, `Sub-decks: ${d.subdecks.join(", ")}`)}</span>}
                    {d.rich && <span className="muted"> · {t("Seiten mit Bildern oder Formeln kommen ins Dokument des Eintrags", "sides with images or formulas go into the record's document")}</span>}
                  </li>
                ))}
              </ul>
            </section>
            {anki.notetypes.map((nt) => {
              const m = mapping[nt.id] || nt.mapping;
              const set = (next: Partial<NotetypeMapping>) => setMapping((all) => ({ ...all, [nt.id]: { ...m, ...next } }));
              const sample = (role: AnkiRole) =>
                nt.fields
                  .map((f, i) => (m.roles[i] === role ? f.sample : ""))
                  .filter(Boolean)
                  .join(" · ");
              return (
                <fieldset key={nt.id} className="study-anki-notetype">
                  <legend>
                    {nt.name} <span className="muted">({kindNames[nt.kind] || nt.kind} · {t(`${nt.notes} Notizen`, `${nt.notes} notes`)})</span>
                  </legend>
                  <div className="form-row study-anki-type">
                    <label>
                      {t("Kartentyp", "Card type")}
                      <Select value={m.type} onChange={(e) => set({ type: e.target.value as AnkiCardType })} aria-label={t(`Kartentyp für ${nt.name}`, `Card type for ${nt.name}`)}>
                        <option value="basic">{t("Vorder-/Rückseite", "Front/back")}</option>
                        <option value="typed">{t("Antwort eintippen", "Type the answer")}</option>
                        <option value="cloze">{t("Lückentext", "Cloze")}</option>
                      </Select>
                    </label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={m.reverse} disabled={m.type === "cloze"} onChange={(e) => set({ reverse: e.target.checked })} />
                      {t("Auch umgekehrt abfragen", "Also ask in reverse")}
                    </label>
                  </div>
                  <div className="study-import-mapping" role="group" aria-label={t(`Felder von ${nt.name}`, `Fields of ${nt.name}`)}>
                    {nt.fields.map((f, i) => (
                      <label key={i}>
                        <span className="study-import-column">
                          {f.name}
                          {f.sample && <small>{f.sample}</small>}
                        </span>
                        <Select
                          value={m.roles[i] || "skip"}
                          aria-label={t(`Ziel für ${f.name}`, `Target for ${f.name}`)}
                          onChange={(e) => set({ roles: nt.fields.map((_, j) => (j === i ? (e.target.value as AnkiRole) : m.roles[j] || "skip")) })}
                        >
                          {ANKI_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {roleNames[role]}
                            </option>
                          ))}
                        </Select>
                      </label>
                    ))}
                  </div>
                  {(sample("front") || sample("back")) && (
                    <p className="study-anki-sample">
                      <span>{sample("front") || "–"}</span>
                      <span aria-hidden> → </span>
                      <span>{sample("back") || "–"}</span>
                    </p>
                  )}
                  {!m.roles.includes("front") && <p className="study-error">{t("Kein Feld auf der Vorderseite: Diese Notizen ergeben keine Karten.", "No field on the front: these notes give no cards.")}</p>}
                </fieldset>
              );
            })}
            {anki.reviews > 0 && (
              <label className="checkbox-label">
                <input type="checkbox" checked={state} onChange={(e) => setState(e.target.checked)} />
                {t(
                  `Meinen Lernstand übernehmen (${anki.reviews} Wiederholungen, nur für dich – mit FSRS nachgerechnet)`,
                  `Take over my learning state (${anki.reviews} reviews, only for you – recalculated with FSRS)`,
                )}
              </label>
            )}
            {preview.warnings.length > 0 && (
              <div className="study-import-errors" role="status">
                <p>
                  <Warning aria-hidden /> {t("Hinweise", "Notes")}
                </p>
                <ul>
                  {preview.warnings.map((w) => (
                    <li key={w}>{warningText(w)}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {error && (
          <p className="study-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions">
        {done ? (
          <>
            {done.rootIds[0] && onOpenPage && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  onClose();
                  onOpenPage(done.rootIds[0]);
                }}
              >
                {t("Stapel öffnen", "Open the deck")}
              </button>
            )}
            <button type="button" className="button primary" onClick={onClose}>
              {t("Fertig", "Done")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button" onClick={close} disabled={busy}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary" disabled={busy || !anki || !cards} onClick={() => void start()}>
              {busy && preview
                ? t("Importiere …", "Importing …")
                : anki?.decks.length === 1
                  ? t(`${cards} Notizen importieren`, `Import ${cards} notes`)
                  : t(`${cards} Notizen in ${anki?.decks.length || 0} Stapel importieren`, `Import ${cards} notes into ${anki?.decks.length || 0} decks`)}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
export default StudyAnkiImport;
