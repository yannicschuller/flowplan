"use client";
// "Parameter optimieren" (docs/specs/flashcards.md §23): fits the FSRS
// weights to the person's own ratings of this deck, of a part of it (a
// sub-deck or a card type, #344) or of all their decks and recommends a
// retention. The log comes from the server (study.history); the fit runs
// in a Web Worker (./optimize-worker.ts) in this browser; only the 21
// numbers and the fit go back (study.params).
// The result in plain words (do the new weights predict the ratings
// better?), the recommended retention with the workload per desired
// retention (cards per day, simulated within the person's limits and an
// optional time budget, #344); the measures behind it – log loss and RMSE
// (bins) of FSRS-6's defaults, of the weights in use and of the new ones –
// in a disclosure. The person decides whether to apply them. Loaded on
// demand from the deck's "Meine Einstellungen" (components/database-
// study.tsx), never with the app shell.
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { Modal, api } from "../ui";
import { Select } from "../select";
import { ChartTable, LineChart } from "../charts";
import { studyZoneNow, type StudyFit, type StudyModel, type StudyOverview } from "./focus";
import { formatNumber } from "@/lib/field-format";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { ReviewCosts, SimDeck, TrainingCard, WorkloadPoint } from "@/lib/fsrs/optimize";
import type { OptimizeJob, OptimizeMessage } from "./optimize-worker";

type Scope = "deck" | "group" | "all";
type Group = { key: string; kind: "subdeck" | "type"; value: string; cards: number; stored: boolean };
type History = {
  scope: "deck" | "all";
  group: string | null;
  groups: Group[];
  reviews: number;
  minimum: number;
  cards: TrainingCard[];
  costs: ReviewCosts;
  current: number[] | null;
  retention: number;
  maxInterval: number;
  model: StudyModel;
  stored: { at: number | null; reviews: number } | null;
  truncated: boolean;
  deck: SimDeck;
};
type Result = Extract<OptimizeMessage, { type: "done" }>;
type Ready = Extract<StudyOverview, { configured: true }>;

export default function StudyOptimize({
  open,
  onClose,
  pageId,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pageId: string;
  onApplied: (overview: Ready, notice: string) => void;
}) {
  const t = useT();
  const [scope, setScope] = useState<Scope>("deck");
  const [group, setGroup] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [work, setWork] = useState<{ retention: number; curve: WorkloadPoint[] } | null>(null);
  const [budget, setBudget] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | null>(null);
  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
    setProgress(null);
  };
  useEffect(() => {
    if (!open) return;
    let live = true;
    setHistory(null);
    setResult(null);
    setWork(null);
    setError("");
    if (scope === "group" && !group) return;
    api<History>("/api/command", { action: "study.history", pageId, scope: scope === "all" ? "all" : "deck", ...(scope === "group" ? { group } : {}), zone: studyZoneNow() })
      .then((h) => {
        if (!live) return;
        setHistory(h);
        if (h.scope === "deck") setGroups(h.groups);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
      stop();
    };
  }, [open, pageId, scope, group]);
  useEffect(() => () => stop(), []);

  const minutes = (() => {
    const n = Math.round(Number(budget));
    return budget.trim() && Number.isFinite(n) && n >= 1 ? Math.min(1440, n) : null;
  })();
  const simDeck = (h: History): SimDeck => ({ ...h.deck, budget: minutes ? minutes * 60 : null });
  const start = (job: OptimizeJob, onDone: (m: OptimizeMessage) => void) => {
    stop();
    setError("");
    setProgress(0);
    const w = new Worker(new URL("./optimize-worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (event: MessageEvent<OptimizeMessage>) => {
      const m = event.data;
      if (m.type === "progress") setProgress(m.value);
      else {
        stop();
        if (m.type === "error") setError(t("Die Berechnung ist fehlgeschlagen.", "The calculation failed.") + ` ${m.message}`);
        else onDone(m);
      }
    };
    w.onerror = () => {
      stop();
      setError(t("Die Berechnung ist fehlgeschlagen.", "The calculation failed."));
    };
    w.postMessage(job);
  };
  const run = () => {
    if (!history) return;
    setResult(null);
    setWork(null);
    start({ cards: history.cards, current: history.current, costs: history.costs, maxInterval: history.maxInterval, deck: simDeck(history) }, (m) => {
      if (m.type !== "done") return;
      setResult(m);
      setWork({ retention: m.retention, curve: m.curve });
    });
  };
  // Another time budget: only the workload again.
  const simulateAgain = () => {
    if (!history || !result) return;
    start({ kind: "workload", weights: result.weights, costs: history.costs, maxInterval: history.maxInterval, deck: simDeck(history) }, (m) => m.type === "workload" && setWork({ retention: m.retention, curve: m.curve }));
  };
  const send = async (body: Record<string, unknown>, notice: string) => {
    setBusy(true);
    try {
      const overview = await api<Ready>("/api/command", { pageId, zone: studyZoneNow(), ...body });
      onApplied(overview, notice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const target = scope === "group" ? { scope: "deck", group } : { scope };
  const apply = () =>
    result &&
    history &&
    void send(
      { action: "study.params", ...target, weights: result.weights, reviews: history.reviews, fit: { before: result.fits.current ?? result.fits.defaults, after: result.fits.fitted } },
      t("Deine optimierten Parameter gelten ab jetzt.", "Your optimised parameters apply from now on."),
    );
  const reset = () =>
    void send(
      { action: "study.params", ...target, weights: null },
      scope === "group" ? t("Dieser Teil nutzt wieder die Parameter des Stapels.", "This part uses the deck's parameters again.") : t("Wieder die Standardparameter von FSRS-6.", "FSRS-6's default parameters again."),
    );
  const applyRetention = (retention: number) =>
    void send({ action: "study.prefs", retention }, t(`Behaltensrate ${Math.round(retention * 100)} % übernommen.`, `Retention ${Math.round(retention * 100)} % applied.`));

  const date = (at: number | null) => (at ? new Intl.DateTimeFormat(LOCALE_TAG, { day: "numeric", month: "long", year: "numeric" }).format(new Date(at)) : "");
  const decimal = (n: number, digits: number) => formatNumber(n, "", digits);
  const percent = (n: number) => `${formatNumber(n * 100, "", 1)} %`;
  const typeNames: Record<string, string> = {
    basic: t("Vorder-/Rückseite", "Front/back"),
    cloze: t("Lückentext", "Cloze"),
    typed: t("Antwort eintippen", "Type the answer"),
    choice: t("Multiple Choice", "Multiple choice"),
    occlusion: t("Bildverdeckung", "Image occlusion"),
  };
  const groupName = (g: Group) => (g.kind === "subdeck" ? t(`Unterstapel „${g.value}“`, `Sub-deck “${g.value}”`) : t(`Kartentyp ${typeNames[g.value] || g.value}`, `Card type ${typeNames[g.value] || g.value}`));
  const enough = !!history && history.reviews >= history.minimum;
  const fits = result?.fits;
  const baseline = fits ? (fits.current ?? fits.defaults) : null;
  const better = !!fits && !!baseline && fits.fitted.logLoss < baseline.logLoss - 1e-5;
  const columns: { key: string; label: string; fit: StudyFit }[] = fits
    ? [
        { key: "defaults", label: t("Vorgabe", "Default"), fit: fits.defaults },
        ...(fits.current ? [{ key: "current", label: t("Bisher", "Current"), fit: fits.current }] : []),
        { key: "fitted", label: t("Optimiert", "Optimised"), fit: fits.fitted },
      ]
    : [];
  const storedHere = history?.stored;
  const recommended = work ? Math.round(work.retention * 100) : null;
  const now = history ? Math.round(history.retention * 100) : null;
  const pointAt = (p: number | null) => (work && p !== null ? work.curve.find((x) => Math.round(x.retention * 100) === p) : undefined);
  const chosen = pointAt(recommended);
  const scopes: [Scope, string][] = [
    ["deck", t("Dieser Stapel", "This deck")],
    ...(groups.length ? ([["group", t("Teil des Stapels", "Part of the deck")]] as [Scope, string][]) : []),
    ["all", t("Alle meine Stapel", "All my decks")],
  ];
  return (
    <Modal open={open} onClose={onClose} title={t("Parameter optimieren", "Optimise parameters")} className="study-optimize" sheet>
      <p className="muted">
        {t(
          "Flowplan passt das Gedächtnismodell (FSRS) an deine eigenen Wertungen an. Gerechnet wird in deinem Browser; gespeichert werden nur die 21 Parameter.",
          "Flowplan fits the memory model (FSRS) to your own ratings. The calculation runs in your browser; only the 21 parameters are stored.",
        )}
      </p>
      <div className="segmented study-optimize-scope" role="group" aria-label={t("Wertungen", "Ratings")}>
        {scopes.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={scope === key}
            className={scope === key ? "selected" : ""}
            disabled={progress !== null}
            onClick={() => {
              if (key === "group" && !group) setGroup(groups[0]?.key || "");
              setScope(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {scope === "group" && (
        <label className="study-optimize-group">
          {t("Teil", "Part")}
          <Select value={group} disabled={progress !== null} onChange={(e) => setGroup(e.target.value)}>
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {groupName(g)} ({g.cards === 1 ? t("1 Karte", "1 card") : t(`${formatNumber(g.cards)} Karten`, `${formatNumber(g.cards)} cards`)})
              </option>
            ))}
          </Select>
        </label>
      )}
      {error && (
        <p className="study-error" role="alert">
          {error}
        </p>
      )}
      {!history && !error && <p className="muted">{t("Wertungen werden geladen …", "Loading ratings …")}</p>}
      {history && (
        <p className="study-optimize-status">
          {scope === "group"
            ? storedHere?.at
              ? t(`Dieser Teil nutzt deine Parameter vom ${date(storedHere.at)}.`, `This part uses your parameters of ${date(storedHere.at)}.`)
              : t("Dieser Teil nutzt die Parameter des Stapels.", "This part uses the deck's parameters.")
            : storedHere?.at
              ? scope === "all"
                ? t(`Für alle Stapel gelten deine Parameter vom ${date(storedHere.at)}.`, `Your parameters of ${date(storedHere.at)} apply to all decks.`)
                : t(`Dieser Stapel nutzt deine Parameter vom ${date(storedHere.at)}.`, `This deck uses your parameters of ${date(storedHere.at)}.`)
              : scope === "deck" && history.model.source === "all"
                ? t(`Dieser Stapel nutzt deine Parameter für alle Stapel vom ${date(history.model.at)}.`, `This deck uses your parameters for all decks of ${date(history.model.at)}.`)
                : t("Derzeit gelten die Standardparameter von FSRS-6.", "FSRS-6's default parameters apply now.")}{" "}
          {t(`${formatNumber(history.reviews)} Wertungen.`, `${formatNumber(history.reviews)} ratings.`)}
        </p>
      )}
      {history && !enough && (
        <p className="study-optimize-few" role="status">
          {t(
            `Zum Optimieren braucht es mindestens ${formatNumber(history.minimum)} Wertungen – hier sind es ${formatNumber(history.reviews)}. Lerne weiter; bis dahin passen die Standardparameter gut.`,
            `Optimising needs at least ${formatNumber(history.minimum)} ratings – there are ${formatNumber(history.reviews)} here. Keep studying; until then the default parameters work well.`,
          )}
        </p>
      )}
      {history?.truncated && <p className="muted">{t("Es zählen die 200 000 Wertungen der am längsten gelernten Karten.", "The 200,000 ratings of the cards studied longest count.")}</p>}
      {progress !== null && (
        <div className="study-optimize-progress" role="status">
          <progress max={1} value={progress} aria-label={t("Fortschritt", "Progress")} />
          <span>{t(`Berechne … ${Math.round(progress * 100)} %`, `Calculating … ${Math.round(progress * 100)} %`)}</span>
        </div>
      )}
      {result && fits && history && (
        <section className="study-optimize-result" aria-label={t("Ergebnis", "Result")}>
          <p className="study-optimize-verdict" role="status">
            {better ? (
              <>
                <strong className="better">{t("Die neuen Parameter passen besser zu dir.", "The new parameters fit you better.")}</strong>{" "}
                {t(
                  `Flowplan sagt damit genauer voraus, wann du eine Karte vergisst – ausgewertet aus ${formatNumber(fits.fitted.items)} Wiederholungen nach mindestens einem Tag.`,
                  `With them Flowplan predicts more accurately when you forget a card – based on ${formatNumber(fits.fitted.items)} reviews after a day or more.`,
                )}
              </>
            ) : (
              t(
                `Keine Verbesserung – deine bisherigen Parameter passen schon gut (ausgewertet aus ${formatNumber(fits.fitted.items)} Wiederholungen nach mindestens einem Tag).`,
                `No improvement – your current parameters already fit well (based on ${formatNumber(fits.fitted.items)} reviews after a day or more).`,
              )
            )}
          </p>
          {work && recommended !== null && now !== null && (
            <div className="study-optimize-retention">
              <p>
                <strong>{t(`Empfohlene Behaltensrate: ${recommended} %`, `Recommended retention: ${recommended} %`)}</strong>{" "}
                <span className="muted">
                  {minutes
                    ? t(
                        `(jetzt ${now} %) – damit behältst du laut Modell am meisten für deine Zeit, mit deinen Tagesgrenzen und ${minutes} Minuten am Tag.`,
                        `(now ${now} %) – the model says this keeps the most in memory for your time, with your daily limits and ${minutes} minutes a day.`,
                      )
                    : t(
                        `(jetzt ${now} %) – damit verbringst du laut Modell am wenigsten Zeit je behaltener Karte, mit deinen Tagesgrenzen.`,
                        `(now ${now} %) – the model says this costs you the least time per card remembered, with your daily limits.`,
                      )}
                </span>
              </p>
              {chosen && (
                <p className="muted">
                  {chosen.cardsPerDay < 1.5 || chosen.minutesPerDay < 1.5
                    ? t(
                        `Bei ${recommended} % ist es im Mittel kaum mehr als eine Karte oder Minute am Tag.`,
                        `At ${recommended} % that is hardly more than a card or a minute a day on average.`,
                      )
                    : t(
                        `Bei ${recommended} % sind es im Mittel etwa ${formatNumber(chosen.cardsPerDay, "", 0)} Karten und ${formatNumber(chosen.minutesPerDay, "", 0)} Minuten am Tag.`,
                        `At ${recommended} % that is about ${formatNumber(chosen.cardsPerDay, "", 0)} cards and ${formatNumber(chosen.minutesPerDay, "", 0)} minutes a day on average.`,
                      )}
                </p>
              )}
              <div className="study-optimize-workload">
                <LineChart
                  title={t("Karten pro Tag je Behaltensrate", "Cards per day by retention")}
                  description={t("Simuliert über ein Jahr mit deinen Karten und Tagesgrenzen", "Simulated over a year with your cards and daily limits")}
                  x={work.curve.map((p) => Math.round(p.retention * 100))}
                  series={[{ key: "cards", label: t("Karten pro Tag", "Cards per day"), values: work.curve.map((p) => p.cardsPerDay), color: 0 }]}
                  formatX={(p) => `${p} %`}
                  formatTip={(p) => t(`Behaltensrate ${p} %`, `Retention ${p} %`)}
                  formatY={(n) => formatNumber(n, "", Math.max(...work.curve.map((p) => p.cardsPerDay)) < 10 ? 1 : 0)}
                  height={150}
                  area={false}
                  marks={[
                    ...(now >= 70 && now <= 95 ? [{ index: now - 70, label: t(`jetzt ${now} %`, `now ${now} %`) }] : []),
                    ...(recommended !== now ? [{ index: recommended - 70, label: t(`empfohlen ${recommended} %`, `recommended ${recommended} %`) }] : []),
                  ]}
                />
                <ChartTable
                  caption={t("Karten und Minuten pro Tag je Behaltensrate", "Cards and minutes per day by retention")}
                  head={[t("Behaltensrate", "Retention"), t("Karten pro Tag", "Cards per day"), t("Minuten pro Tag", "Minutes per day")]}
                  rows={work.curve.map((p) => [`${Math.round(p.retention * 100)} %`, formatNumber(p.cardsPerDay, "", 1), formatNumber(p.minutesPerDay, "", 1)])}
                />
              </div>
              <div className="study-optimize-budget">
                <label>
                  {t("Zeit pro Tag (Minuten, optional)", "Time per day (minutes, optional)")}
                  <input type="number" min={1} max={1440} inputMode="numeric" placeholder={t("ohne", "none")} value={budget} onChange={(e) => setBudget(e.target.value)} />
                </label>
                <button type="button" className="button compact" disabled={progress !== null} onClick={simulateAgain}>
                  {t("Neu berechnen", "Recalculate")}
                </button>
              </div>
              {recommended !== now && (
                <button type="button" className="button compact" disabled={busy} onClick={() => applyRetention(work.retention)}>
                  {t(`Behaltensrate auf ${recommended} % setzen`, `Set retention to ${recommended} %`)}
                </button>
              )}
            </div>
          )}
          <details className="study-optimize-details">
            <summary>{t("Details zur Berechnung", "Calculation details")}</summary>
            <table className="study-stats-table">
              <caption>
                {t(
                  "Wie weit die Vorhersagen des Modells von deinen tatsächlichen Wertungen abweichen – kleiner ist besser. Log-Loss bewertet jede einzelne Vorhersage, RMSE die Abweichung in Gruppen ähnlicher Wiederholungen.",
                  "How far the model's predictions are from your actual ratings – lower is better. Log loss scores every single prediction, RMSE the deviation in groups of similar reviews.",
                )}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("Kennzahl", "Measure")}</th>
                  {columns.map((c) => (
                    <th scope="col" key={c.key}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{t("Log-Loss", "Log loss")}</th>
                  {columns.map((c) => (
                    <td key={c.key}>{decimal(c.fit.logLoss, 4)}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">{t("RMSE (Klassen)", "RMSE (bins)")}</th>
                  {columns.map((c) => (
                    <td key={c.key}>{percent(c.fit.rmse)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </details>
        </section>
      )}
      <div className="modal-actions study-optimize-actions">
        {storedHere?.at && (
          <button type="button" className="button" disabled={busy || progress !== null} onClick={reset}>
            {scope === "group" ? t("Parameter des Stapels nutzen", "Use the deck's parameters") : t("Auf Vorgabe zurücksetzen", "Reset to defaults")}
          </button>
        )}
        {result && better ? (
          <>
            <button type="button" className="button" onClick={onClose}>
              {storedHere?.at || history?.model.source !== "default" || scope === "group" ? t("Bisherige behalten", "Keep current") : t("Vorgabe behalten", "Keep defaults")}
            </button>
            <button type="button" className="button primary" disabled={busy} onClick={apply}>
              {t("Parameter übernehmen", "Use parameters")}
            </button>
          </>
        ) : result ? (
          <button type="button" className="button" onClick={onClose}>
            {t("Schließen", "Close")}
          </button>
        ) : progress !== null ? (
          <button type="button" className="button" onClick={stop}>
            {t("Abbrechen", "Cancel")}
          </button>
        ) : (
          <button type="button" className="button primary" disabled={!enough || busy} onClick={run}>
            {t("Optimieren", "Optimise")}
          </button>
        )}
      </div>
    </Modal>
  );
}
