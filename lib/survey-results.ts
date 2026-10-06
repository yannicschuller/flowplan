// The analysis of a survey from its records: per question counts, shares,
// averages, the NPS score, matrix tables, average ranks and the latest
// text answers. Client-safe; computed from the rows the viewer may see.
import { isQuestion, range, type Survey, type SurveyQuestion } from "./survey";
import type { Field, Row } from "./types";

export type Bar = { label: string; count: number; share: number };
export type QuestionResult =
  | { kind: "choice"; q: SurveyQuestion; answered: number; bars: Bar[]; others: string[] }
  | { kind: "number"; q: SurveyQuestion; answered: number; average: number | null; min: number | null; max: number | null; bars: Bar[]; nps?: { score: number; promoters: number; passives: number; detractors: number } }
  | { kind: "ranking"; q: SurveyQuestion; answered: number; items: { label: string; average: number }[] }
  | { kind: "matrix"; q: SurveyQuestion; answered: number; rows: { label: string; counts: number[]; average: number | null }[]; columns: string[] }
  | { kind: "text"; q: SurveyQuestion; answered: number; answers: string[] }
  | { kind: "files"; q: SurveyQuestion; answered: number };

const answered = (v: unknown) => !(v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length));
const round = (n: number) => Math.round(n * 10) / 10;

export function surveyResults(survey: Survey, fields: Field[], rows: Row[]) {
  const results: QuestionResult[] = [];
  for (const q of survey.items.filter(isQuestion)) {
    const field = fields.find((f) => f.id === q.field);
    const values = rows.map((r) => r.cells[q.field]).filter(answered);
    if (q.type === "matrix") {
      const table = q.rows.map((row) => {
        const counts = q.columns.map((c) => rows.filter((r) => r.cells[row.field] === c).length);
        const total = counts.reduce((a, b) => a + b, 0);
        const sum = counts.reduce((a, n, i) => a + n * (i + 1), 0);
        return { label: row.label, counts, average: total ? round(sum / total) : null };
      });
      const any = rows.filter((r) => q.rows.some((row) => answered(r.cells[row.field]))).length;
      results.push({ kind: "matrix", q, answered: any, rows: table, columns: q.columns });
      continue;
    }
    if (q.type === "file") {
      results.push({ kind: "files", q, answered: values.length });
      continue;
    }
    if (["single", "dropdown", "yesno", "multiple"].includes(q.type)) {
      const options = field?.options || [];
      const flat = values.flatMap((v) => (Array.isArray(v) ? v.map(String) : [String(v)]));
      const others = flat.filter((v) => !options.includes(v));
      const bars = options.map((o) => {
        const count = flat.filter((v) => v === o).length;
        return { label: o, count, share: values.length ? count / values.length : 0 };
      });
      if (others.length) bars.push({ label: "@other", count: others.length, share: values.length ? others.length / values.length : 0 });
      results.push({ kind: "choice", q, answered: values.length, bars, others: others.slice(-20).reverse() });
      continue;
    }
    if (q.type === "ranking") {
      const options = field?.options || [];
      const items = options
        .map((o) => {
          const places = values.map((v) => (Array.isArray(v) ? v.indexOf(o) : -1)).filter((i) => i >= 0);
          return { label: o, average: places.length ? round(places.reduce((a, b) => a + b + 1, 0) / places.length) : 0 };
        })
        .sort((a, b) => a.average - b.average);
      results.push({ kind: "ranking", q, answered: values.length, items });
      continue;
    }
    if (["rating", "nps", "scale", "slider", "number"].includes(q.type)) {
      const numbers = values.map(Number).filter(Number.isFinite);
      const r = range(q);
      const discrete = ["rating", "nps", "scale"].includes(q.type) && r.min !== undefined && r.max !== undefined;
      let bars: Bar[] = [];
      if (discrete)
        bars = Array.from({ length: r.max! - r.min! + 1 }, (_, i) => r.min! + i).map((n) => {
          const count = numbers.filter((x) => x === n).length;
          return { label: String(n), count, share: numbers.length ? count / numbers.length : 0 };
        });
      else if (numbers.length) {
        // Five equal ranges between the smallest and the largest answer.
        const lo = Math.min(...numbers),
          hi = Math.max(...numbers);
        const width = (hi - lo) / 5 || 1;
        bars = Array.from({ length: hi === lo ? 1 : 5 }, (_, i) => {
          const from = lo + i * width,
            to = i === 4 ? hi : from + width;
          const count = numbers.filter((x) => x >= from && (i === 4 || hi === lo ? x <= to : x < to)).length;
          const label = hi === lo ? String(lo) : `${round(from)}–${round(to)}`;
          return { label, count, share: count / numbers.length };
        });
      }
      const result: QuestionResult = {
        kind: "number",
        q,
        answered: numbers.length,
        average: numbers.length ? round(numbers.reduce((a, b) => a + b, 0) / numbers.length) : null,
        min: numbers.length ? Math.min(...numbers) : null,
        max: numbers.length ? Math.max(...numbers) : null,
        bars,
      };
      if (q.type === "nps" && numbers.length) {
        const promoters = numbers.filter((n) => n >= 9).length,
          detractors = numbers.filter((n) => n <= 6).length;
        result.nps = {
          promoters,
          detractors,
          passives: numbers.length - promoters - detractors,
          score: Math.round(((promoters - detractors) / numbers.length) * 100),
        };
      }
      results.push(result);
      continue;
    }
    // Text, e-mail, phone, website, date, time: the latest answers.
    const ordered = rows
      .filter((r) => answered(r.cells[q.field]))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((r) => String(r.cells[q.field]));
    results.push({ kind: "text", q, answered: ordered.length, answers: ordered.slice(0, 50) });
  }
  // Answers per day (the last 30 days with answers).
  const days = new Map<string, number>();
  for (const r of rows) {
    const day = String(r.created_at || "").slice(0, 10);
    if (day) days.set(day, (days.get(day) || 0) + 1);
  }
  const timeline = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  return { responses: rows.length, timeline, questions: results };
}
