"use client";
import { useT, useLocale } from "./i18n";
import { surveyResults, type Bar, type QuestionResult } from "@/lib/survey-results";
import type { Survey } from "@/lib/survey";
import type { Field, Row } from "@/lib/types";

// Results of a survey: answers in total and per day, then one card per
// question. Every bar carries its number and share as text, so nothing
// depends on colour alone.
export function SurveyResults({ survey, fields, rows }: { survey: Survey; fields: Field[]; rows: Row[] }) {
  const t = useT();
  const locale = useLocale();
  const tag = locale === "de" ? "de-DE" : "en-GB";
  const data = surveyResults(survey, fields, rows);
  const pct = (share: number) => `${Math.round(share * 100)} %`;
  const num = (n: number | null) => (n === null ? "–" : n.toLocaleString(tag));
  const peak = Math.max(1, ...data.timeline.map(([, n]) => n));
  if (!data.responses)
    return (
      <div className="survey-results empty-state">
        <p>{t("Noch keine Antworten. Teile den Link der Umfrage – die Auswertung erscheint hier, sobald Antworten da sind.", "No answers yet. Share the survey link – the results appear here as soon as answers arrive.")}</p>
      </div>
    );
  const bars = (list: Bar[], answered: number) => (
    <ul className="result-bars">
      {list.map((b) => (
        <li key={b.label} title={`${b.label === "@other" ? t("Andere", "Other") : b.label}: ${b.count} (${pct(b.share)})`}>
          <span className="result-label">{b.label === "@other" ? t("Andere", "Other") : b.label}</span>
          <span className="result-track" aria-hidden>
            <span style={{ width: `${b.share * 100}%` }} />
          </span>
          <span className="result-value">
            {b.count} <span className="muted">· {pct(b.share)}</span>
          </span>
        </li>
      ))}
      {!answered && <li className="muted">{t("Keine Antworten.", "No answers.")}</li>}
    </ul>
  );
  const body = (r: QuestionResult) => {
    switch (r.kind) {
      case "choice":
        return (
          <>
            {bars(r.bars, r.answered)}
            {r.others.length > 0 && (
              <details className="result-others">
                <summary>{t(`Andere Antworten (${r.others.length})`, `Other answers (${r.others.length})`)}</summary>
                <ul>{r.others.map((o, i) => <li key={i}>{o}</li>)}</ul>
              </details>
            )}
          </>
        );
      case "number":
        return (
          <>
            {r.nps ? (
              <div className="result-stats">
                <div className="result-hero">
                  <strong>{r.nps.score > 0 ? `+${r.nps.score}` : r.nps.score}</strong>
                  <span>NPS</span>
                </div>
                <div className="nps-split" aria-label={t("Verteilung", "Distribution")}>
                  <span data-band="high">
                    {t("Promotoren (9–10)", "Promoters (9–10)")}: {r.nps.promoters}
                  </span>
                  <span data-band="mid">
                    {t("Passive (7–8)", "Passives (7–8)")}: {r.nps.passives}
                  </span>
                  <span data-band="low">
                    {t("Kritiker (0–6)", "Detractors (0–6)")}: {r.nps.detractors}
                  </span>
                </div>
              </div>
            ) : (
              <div className="result-stats">
                <div className="result-hero">
                  <strong>{num(r.average)}</strong>
                  <span>{t("Durchschnitt", "Average")}</span>
                </div>
                <span className="muted">
                  {t("Min.", "Min")} {num(r.min)} · {t("Max.", "Max")} {num(r.max)}
                </span>
              </div>
            )}
            {bars(r.bars, r.answered)}
          </>
        );
      case "ranking":
        return (
          <ol className="result-ranking">
            {r.items.map((i) => (
              <li key={i.label}>
                <span>{i.label}</span>
                <span className="muted">
                  {t("Ø Platz", "Avg. place")} {i.average.toLocaleString(tag)}
                </span>
              </li>
            ))}
          </ol>
        );
      case "matrix":
        return (
          <div className="result-matrix-wrap">
            <table className="result-matrix">
              <thead>
                <tr>
                  <th scope="col" />
                  {r.columns.map((c) => (
                    <th scope="col" key={c}>
                      {c}
                    </th>
                  ))}
                  <th scope="col">Ø</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row) => {
                  const total = row.counts.reduce((a, b) => a + b, 0) || 1;
                  return (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      {row.counts.map((n, i) => (
                        <td key={i} style={{ "--heat": n / total } as React.CSSProperties}>
                          {n}
                        </td>
                      ))}
                      <td>{num(row.average)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      case "text":
        return r.answers.length ? (
          <ul className="result-texts">
            {r.answers.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t("Keine Antworten.", "No answers.")}</p>
        );
      case "files":
        return <p className="muted">{t(`${r.answered} Antworten mit Dateien – in den Einträgen.`, `${r.answered} answers with files – in the records.`)}</p>;
    }
  };
  return (
    <div className="survey-results">
      <div className="result-summary">
        <div className="result-hero">
          <strong>{data.responses.toLocaleString(tag)}</strong>
          <span>{t("Antworten", "Answers")}</span>
        </div>
        {data.timeline.length > 1 && (
          <div className="result-timeline" role="img" aria-label={t(`Antworten pro Tag, höchstens ${peak}`, `Answers per day, at most ${peak}`)}>
            {data.timeline.map(([day, n]) => (
              <span key={day} title={`${new Date(`${day}T12:00:00`).toLocaleDateString(tag)}: ${n}`} style={{ height: `${Math.max(6, (n / peak) * 100)}%` }} />
            ))}
          </div>
        )}
      </div>
      {data.questions.map((r) => (
        <section key={r.q.id} className="result-card" aria-label={r.q.title}>
          <header>
            <h3>{r.q.title || fields.find((f) => f.id === r.q.field)?.name}</h3>
            <span className="muted">
              {r.answered} {t("Antworten", "answers")}
            </span>
          </header>
          {body(r)}
        </section>
      ))}
    </div>
  );
}
