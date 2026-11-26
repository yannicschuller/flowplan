// Property-based tests (fast-check): one fixed seed for every run, so CI
// never flakes and a failure can be replayed. fast-check names the seed and
// the shrunk counterexample's path in its error; FC_SEED=<n> replays another
// seed, FC_RUNS=<n> multiplies the number of runs (FC_RUNS=20: a long run).
import fc from "fast-check";

export const SEED = Number(process.env.FC_SEED) || 0x5eed_f10;
const SCALE = Number(process.env.FC_RUNS) || 1;
fc.configureGlobal({ seed: SEED });

// fc.assert with the seed and the number of runs; the seed is printed on
// failure (also when fast-check's own message is cut off by the runner).
export function check<Ts extends [unknown, ...unknown[]]>(
  property: fc.IProperty<Ts> | fc.IAsyncProperty<Ts>,
  numRuns: number,
) {
  const params = { seed: SEED, includeErrorInReport: true, numRuns: Math.max(1, Math.round(numRuns * SCALE)) };
  const report = (error: unknown) => {
    console.error(`property failed with seed ${SEED} (replay: FC_SEED=${SEED})`);
    throw error;
  };
  try {
    const result = fc.assert(property as fc.IProperty<Ts>, params) as unknown;
    if (result instanceof Promise) return result.catch(report);
  } catch (error) {
    report(error);
  }
}

// Text that is hard for parsers and formats: Markdown and CSV syntax,
// brackets, quotes, unicode (emoji, combining marks, RTL, CJK), control
// characters other than NUL, and plain letters so that words form too.
const NASTY = [
  "|", "`", "``", "```", "*", "**", "_", "__", "~", "~~", "[", "]", "(", ")", "<", ">", "{", "}",
  "#", "# ", "- ", "+ ", "1. ", "> ", "!", "\\", "&", "&amp;", "\"", "'", ",", ";", "$", "$$", "^", "=", "@",
  ":", "://", "www.", "http://x.test", "\t", "\r", "\u00a0", "\u200b", "\ufeff", "\u0001", "\u001f", "\u007f",
  "\u0085", "\u2028", "\u202e", "é", "e\u0301", "ß", "İ", "ﬁ", "Ω", "中文", "日本", "한", "שלום", "مرحبا",
  "😀", "👩\u200d💻", "🇩🇪", "\u{1d11e}", "a", "b", "x", "Wort", "word", "1", "42", " ", " ",
];
export const nastyPiece = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...NASTY) },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 3 }) },
);
export const nastyText = (maxPieces = 8) =>
  fc.array(nastyPiece, { maxLength: maxPieces }).map((parts) => parts.join(""));
