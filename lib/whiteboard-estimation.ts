// Planning poker on whiteboards: decks, what each person may see of the
// votes, and the result (distribution, average, median, consensus).
// Client-safe; the server keeps the session (lib/whiteboard-facilitation.ts)
// and only ever sends others' votes once they are revealed.
import { z } from "zod";

export const DECKS = {
  fibonacci: ["1", "2", "3", "5", "8", "13", "21", "?", "☕"],
  tshirt: ["XS", "S", "M", "L", "XL"],
} as const;
export type DeckKind = keyof typeof DECKS | "custom";
// Cards that are not an estimate: "no idea" and "I need a break".
export const ABSTAIN = new Set(["?", "☕"]);

export const deckValue = z.string().trim().min(1).max(12);
export const deckSchema = z.object({
  kind: z.enum(["fibonacci", "tshirt", "custom"]),
  values: z.array(deckValue).min(2).max(20),
});
export type Deck = z.infer<typeof deckSchema>;
export function deckOf(kind: DeckKind, custom = ""): Deck {
  if (kind !== "custom") return { kind, values: [...DECKS[kind]] };
  return { kind, values: parseCustomDeck(custom) };
}
// "1, 2, 4, 8" or "S M L": up to 20 distinct values of up to 12 characters.
export function parseCustomDeck(text: string) {
  const values = text
    .split(/[,;\n]|\s+/)
    .map((v) => v.trim().slice(0, 12))
    .filter(Boolean);
  return [...new Set(values)].slice(0, 20);
}

export const estimationSchema = z.object({
  id: z.string().uuid(),
  deck: deckSchema,
  items: z.array(z.string().min(1).max(100)).min(1).max(100),
  index: z.number().int().min(0),
  round: z.string().uuid(),
  revealed: z.boolean(),
  by: z.string().max(100),
  name: z.string().max(200),
  startedAt: z.number(),
  // Values taken over per item ("Ergebnis übernehmen").
  results: z.record(z.string(), z.string().max(12)).default({}),
});
export type Estimation = z.infer<typeof estimationSchema>;
export type EstimateVote = { userId: string; name: string; value: string };

const numeric = (value: string) => {
  const n = Number(value.replace(",", ".").replace("½", "0.5"));
  return value.trim() && Number.isFinite(n) ? n : null;
};
export type EstimateStats = {
  votes: number;
  // Votes that are an estimate (not "?" or ☕).
  counted: number;
  distribution: { value: string; count: number }[];
  average: number | null;
  median: string | null;
  consensus: boolean;
  // What "Ergebnis übernehmen" proposes: the agreed value, else the card
  // nearest to the median (ties: the larger one).
  suggestion: string | null;
};
export function estimateStats(values: string[], deck: string[]): EstimateStats {
  const order = (v: string) => {
    const i = deck.indexOf(v);
    return i < 0 ? deck.length : i;
  };
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const distribution = [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => order(a.value) - order(b.value) || a.value.localeCompare(b.value));
  const counted = values.filter((v) => !ABSTAIN.has(v));
  const numbers = counted.map(numeric);
  const allNumeric = counted.length > 0 && numbers.every((n) => n !== null);
  let average: number | null = null,
    median: string | null = null,
    suggestion: string | null = null;
  if (allNumeric) {
    const sorted = (numbers as number[]).slice().sort((a, b) => a - b);
    average = Math.round((sorted.reduce((s, n) => s + n, 0) / sorted.length) * 10) / 10;
    const mid = sorted.length / 2;
    const m = sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
    median = String(Math.round(m * 10) / 10);
    // The deck's numeric card nearest to the median.
    const cards = deck.map((v) => [v, numeric(v)] as const).filter((c): c is readonly [string, number] => c[1] !== null);
    suggestion = cards.length
      ? cards.reduce((best, c) => (Math.abs(c[1] - m) < Math.abs(best[1] - m) || (Math.abs(c[1] - m) === Math.abs(best[1] - m) && c[1] > best[1]) ? c : best))[0]
      : median;
  } else if (counted.length) {
    // Sizes (S, M, L …): the middle card by the deck's order.
    const sorted = counted.slice().sort((a, b) => order(a) - order(b));
    median = sorted[Math.floor((sorted.length - 1) / 2)];
    suggestion = median;
  }
  const consensus = counted.length >= 2 && counted.every((v) => v === counted[0]);
  if (consensus) suggestion = counted[0];
  return { votes: values.length, counted: counted.length, distribution, average, median, consensus, suggestion };
}

// What one person gets to see of a round: before the reveal only who has
// voted (and their own card), afterwards every card and the result.
export type EstimationView = Estimation & {
  votes: { userId: string; name: string; value?: string }[];
  mine: string | null;
  stats: EstimateStats | null;
};
export function estimationView(session: Estimation, votes: EstimateVote[], viewer: string): EstimationView {
  const mine = votes.find((v) => v.userId === viewer)?.value ?? null;
  return {
    ...session,
    votes: votes.map((v) => (session.revealed ? { userId: v.userId, name: v.name, value: v.value } : { userId: v.userId, name: v.name })),
    mine,
    stats: session.revealed ? estimateStats(votes.map((v) => v.value), session.deck.values) : null,
  };
}
