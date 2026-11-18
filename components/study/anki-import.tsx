"use client";
// "Aus Anki importieren" (docs/specs/flashcards.md §8.1): an Anki package
// (.apkg, .colpkg) becomes one flashcard database per top-level deck, its
// sub-decks as values of the property "Deck" or, chosen here (#341), as
// databases of their own below the top-level deck's page. The
// file goes up once (lib/importers/upload.ts, a background job with
// progress, components/import-client.ts); the preview shows decks, notes,
// media and per note type what its fields become – card type, reverse card
// and each field's side, as suggested by the server from Anki's templates –
// and the import then uses the kept upload with the mapping chosen here.
// Optionally the person's own learning state comes along (Anki's review log
// replayed through FSRS, for them only; suspended cards stay suspended).
import { useEffect, useMemo, useRef, useState } from "react";
import { FileArrowUp, Warning } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal, needsConnection, offlineNotice } from "../ui";
import { Select } from "../select";
import { sendImport, waitForJob, warningText } from "../import-client";
import { browserZone } from "@/lib/date-values";
import { parseClozeText } from "@/lib/study-cloze";
import { ANKI_MAX_DATABASES, ANKI_ROLES, type AnkiCardType, type AnkiPreview, type AnkiRole, type NotetypeMapping } from "@/lib/anki-mapping";
import type { Space } from "@/lib/types";

type Preview = { warnings: string[]; files: number; bytes: number; upload?: string; anki: AnkiPreview };
type Outcome = { rootIds: string[]; rows: number; reviews?: number; report?: { pageId: string; total: number }; decks?: number };

// Sizes as the media library shows them: KB below a megabyte (a no-break
// space before the unit, so "KB" never stands alone on a phone).
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()}\u00a0KB` : `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })}\u00a0MB`;

// A field's example as the card shows it: Anki's cloze syntax
// ({{c1::answer::hint}}) as a gap ("[…]" or "[hint]") or, revealed, as the
// marked answer; an image occlusion mask as "Maske 1". The examples are cut
// at 80 characters, so a gap left open at the end still counts.
function ClozeSample({ text, reveal }: { text: string; reveal: boolean }) {
  const t = useT();
  if (!text.includes("{{c")) return <>{text}</>;
  const closed = /\{\{c\d{1,2}::(?:(?!\}\})[\s\S])*$/.test(text) ? `${text}}}` : text;
  return (
    <>
      {parseClozeText(closed).map((s, i) =>
        s.type === "text" ? (
          s.text
        ) : s.answer.startsWith("image-occlusion") ? (
          <span key={i} className="cloze-gap">
            {t(`Maske ${s.n}`, `Mask ${s.n}`)}
          </span>
        ) : reveal ? (
          <span key={i} className="cloze-answer">
            {s.answer}
          </span>
        ) : (
          <span key={i} className="cloze-gap">
            {s.hint ? `[${s.hint}]` : "[…]"}
          </span>
        ),
      )}
    </>
  );
}

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
    [subdecks, setSubdecks] = useState<"property" | "databases">("property"),
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
    setSubdecks("property");
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
    // The import is the server's (lib/offline-actions.ts onlineOnlyRequests).
    if (needsConnection()) throw new Error(offlineNotice());
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
      const query = new URLSearchParams({ workspaceId, spaceId: space, source: "anki", name: file.name, anki: JSON.stringify({ notetypes: mapping, state, subdecks: separate ? "databases" : "property" }), zone: browserZone() });
      if (upload.current) query.set("upload", upload.current);
      const result = (await run(query, upload.current ? null : file)) as Outcome;
      upload.current = undefined;
      setDone({ ...result, decks: separate ? anki!.databases : anki!.decks.length });
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
  // Counts with their singular ("1 Notiz", not "1 Notizen").
  const notes = (n: number) => (n === 1 ? t("1 Notiz", "1 note") : t(`${n} Notizen`, `${n} notes`));
  const anki = preview?.anki;
  const cards = useMemo(() => anki?.decks.reduce((n, d) => n + d.notes, 0) || 0, [anki]);
  // Sub-decks as databases of their own: offered when there are any.
  const hasSubdecks = !!anki?.decks.some((d) => d.subdecks.length);
  const tooMany = !!anki && anki.databases > ANKI_MAX_DATABASES;
  const separate = hasSubdecks && !tooMany && subdecks === "databases";
  const deckCount = anki ? (separate ? anki.databases : anki.decks.length) : 0;
  return (
    <Modal open={open} onClose={close} title={t("Aus Anki importieren", "Import from Anki")} wide sheet className="study-import study-anki-import">
      <div className="study-import-body">
        {done ? (
          <div className="study-anki-done" role="status">
            <p>
              {done.rows === 1
                ? t("1 Notiz importiert.", "1 note imported.")
                : (done.decks ?? done.rootIds.length) === 1
                  ? t(`${done.rows} Notizen in einen Stapel importiert.`, `${done.rows} notes imported into one deck.`)
                  : t(`${done.rows} Notizen in ${done.decks ?? done.rootIds.length} Stapeln importiert.`, `${done.rows} notes imported into ${done.decks ?? done.rootIds.length} decks.`)}
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
                "Exportiere in Anki einen Stapel („Datei → Exportieren …“, Format „Anki-Stapelpaket (.apkg)“) oder die ganze Sammlung (.colpkg). Jeder oberste Stapel wird eine Lernkarten-Datenbank; Unterstapel kommen in die Eigenschaft „Deck“ oder werden eigene Datenbanken. Bilder und Töne kommen mit.",
                "In Anki, export a deck (“File → Export …”, format “Anki Deck Package (.apkg)”) or the whole collection (.colpkg). Every top-level deck becomes a flashcard database; sub-decks go into the property “Deck” or become databases of their own. Images and sounds come along.",
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
              <label className={`button compact study-import-file${busy ? " disabled" : ""}${file ? "" : " primary"}`}>
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
                {notes(anki.notes)} · {anki.cards === 1 ? t("1 Karte in Anki", "1 card in Anki") : t(`${anki.cards} Karten in Anki`, `${anki.cards} cards in Anki`)}
                {anki.media.files > 0 &&
                  ` · ${anki.media.files === 1 ? t(`1 Mediendatei\u00a0(${size(anki.media.bytes)})`, `1 media file\u00a0(${size(anki.media.bytes)})`) : t(`${anki.media.files} Mediendateien\u00a0(${size(anki.media.bytes)})`, `${anki.media.files} media files\u00a0(${size(anki.media.bytes)})`)}`}
              </p>
              <ul className="study-anki-decks">
                {anki.decks.map((d) => (
                  <li key={d.name}>
                    <strong>{d.name}</strong>
                    {"\u00a0· "}
                    {notes(d.notes)}
                    {d.subdecks.length > 0 && <span className="muted"> · {t(`Unterstapel: ${d.subdecks.join(", ")}`, `Sub-decks: ${d.subdecks.join(", ")}`)}</span>}
                    {d.rich && <span className="muted"> · {t("Seiten mit Bildern oder Formeln kommen ins Dokument des Eintrags", "sides with images or formulas go into the record's document")}</span>}
                  </li>
                ))}
              </ul>
            </section>
            {hasSubdecks && (
              <fieldset className="study-anki-subdecks">
                <legend>{t("Unterstapel", "Sub-decks")}</legend>
                <label className="checkbox-label">
                  <input type="radio" name="anki-subdecks" checked={!separate} disabled={busy} onChange={() => setSubdecks("property")} />
                  <span>
                    {t("In die Eigenschaft „Deck“", "Into the property “Deck”")}
                    <small className="muted">
                      {t(
                        "Eine Datenbank je oberstem Stapel; in der Lernen-Ansicht filterst du nach Unterstapeln.",
                        "One database per top-level deck; in the study view you filter by sub-deck.",
                      )}
                    </small>
                  </span>
                </label>
                <label className="checkbox-label">
                  <input type="radio" name="anki-subdecks" checked={separate} disabled={busy || tooMany} onChange={() => setSubdecks("databases")} />
                  <span>
                    {t("Als eigene Datenbanken", "As databases of their own")}
                    <small className="muted">
                      {tooMany
                        ? t(`Geht nur bis ${ANKI_MAX_DATABASES} Stapel – dieses Paket hat ${anki.databases}.`, `Only up to ${ANKI_MAX_DATABASES} decks – this package has ${anki.databases}.`)
                        : t(
                            `${anki.databases} Stapel, jeder Unterstapel unter der Seite des Stapels darüber – mit eigenen Grenzen und eigener Statistik.`,
                            `${anki.databases} decks, every sub-deck below the page of the deck above it – with limits and statistics of its own.`,
                          )}
                    </small>
                  </span>
                </label>
              </fieldset>
            )}
            {anki.notetypes.map((nt) => {
              const m = mapping[nt.id] || nt.mapping;
              const set = (next: Partial<NotetypeMapping>) => setMapping((all) => ({ ...all, [nt.id]: { ...m, ...next } }));
              const sample = (role: AnkiRole) =>
                nt.fields
                  .map((f, i) => (m.roles[i] === role ? f.sample : ""))
                  .filter(Boolean)
                  .join(" · ");
              // Cloze and occlusion cards have no reverse card; a cloze card
              // asks its text with gaps and reveals the same text.
              const gaps = m.type === "cloze" || m.type === "occlusion";
              return (
                <fieldset key={nt.id} className="study-anki-notetype">
                  <legend>
                    {nt.name} <span className="muted">({kindNames[nt.kind] || nt.kind}{"\u00a0· "}{notes(nt.notes)})</span>
                  </legend>
                  <div className="form-row study-anki-type">
                    <label>
                      {t("Kartentyp", "Card type")}
                      <Select value={m.type} onChange={(e) => set({ type: e.target.value as AnkiCardType })} aria-label={t(`Kartentyp für ${nt.name}`, `Card type for ${nt.name}`)}>
                        <option value="basic">{t("Vorder-/Rückseite", "Front/back")}</option>
                        <option value="typed">{t("Antwort eintippen", "Type the answer")}</option>
                        <option value="cloze">{t("Lückentext", "Cloze")}</option>
                        {nt.kind === "occlusion" && <option value="occlusion">{t("Bildverdeckung (mit Masken)", "Image occlusion (with masks)")}</option>}
                      </Select>
                    </label>
                    {!gaps && (
                      <label className="checkbox-label">
                        <input type="checkbox" checked={m.reverse} onChange={(e) => set({ reverse: e.target.checked })} />
                        {t("Auch umgekehrt abfragen", "Also ask in reverse")}
                      </label>
                    )}
                  </div>
                  <div className="study-import-mapping" role="group" aria-label={t(`Felder von ${nt.name}`, `Fields of ${nt.name}`)}>
                    {nt.fields.map((f, i) => (
                      <label key={i}>
                        <span className="study-import-column">
                          {f.name}
                          {f.sample && (
                            <small>
                              <ClozeSample text={f.sample} reveal />
                            </small>
                          )}
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
                      <span>{sample("front") ? <ClozeSample text={sample("front")} reveal={false} /> : "–"}</span>
                      <span aria-hidden> → </span>
                      <span>
                        {m.type === "cloze" && sample("front") ? (
                          <>
                            <ClozeSample text={sample("front")} reveal />
                            {sample("back") && ` · ${sample("back")}`}
                          </>
                        ) : (
                          sample("back") || "–"
                        )}
                      </span>
                    </p>
                  )}
                  {!m.roles.includes("front") && <p className="study-error">{t("Kein Feld auf der Vorderseite: Diese Notizen ergeben keine Karten.", "No field on the front: these notes give no cards.")}</p>}
                </fieldset>
              );
            })}
            {(anki.reviews > 0 || anki.suspendedNew > 0) && (
              <label className="checkbox-label">
                <input type="checkbox" checked={state} onChange={(e) => setState(e.target.checked)} />
                {anki.reviews > 0
                  ? t(
                      `Meinen Lernstand übernehmen (${anki.reviews} Wiederholungen, nur für dich – mit FSRS nachgerechnet)`,
                      `Take over my learning state (${anki.reviews} reviews, only for you – recalculated with FSRS)`,
                    )
                  : t("Meinen Lernstand übernehmen (nur für dich)", "Take over my learning state (only for you)")}
                {anki.suspended > 0 &&
                  ` · ${anki.suspended === 1 ? t("1 ausgesetzte Karte bleibt ausgesetzt", "1 suspended card stays suspended") : t(`${anki.suspended} ausgesetzte Karten bleiben ausgesetzt`, `${anki.suspended} suspended cards stay suspended`)}`}
              </label>
            )}
            {!cards && (
              <p className="study-anki-empty" role="status">
                {t(
                  "In diesem Paket sind keine Notizen, die Flowplan übernehmen kann. Exportiere in Anki einen Stapel mit Karten und wähle die Datei hier erneut.",
                  "This package has no notes Flowplan can take over. In Anki, export a deck with cards and choose the file here again.",
                )}
              </p>
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
            {/* Only once there is something to import: before, the file
                button is the main action; an empty package is explained. */}
            {anki && cards > 0 && (
              <button type="button" className="button primary" disabled={busy} onClick={() => void start()}>
                {busy && preview
                  ? t("Importiere …", "Importing …")
                  : deckCount === 1
                    ? cards === 1
                      ? t("1 Notiz importieren", "Import 1 note")
                      : t(`${cards} Notizen importieren`, `Import ${cards} notes`)
                    : t(`${notes(cards)} in ${deckCount} Stapel importieren`, `Import ${notes(cards)} into ${deckCount} decks`)}
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
export default StudyAnkiImport;
