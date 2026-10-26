// Text passages for "ask": documents split into paragraphs, merged into
// chunks of a few hundred characters, ranked against a question and picked
// within a size budget. Pure functions – no database, no provider.

// Roughly 250 tokens per chunk: small enough to rank precisely, large
// enough to carry a thought.
export const CHUNK_TARGET = 900;
export const CHUNK_MAX = 1400;

const ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", amp: "&" };
const decode = (text: string) => text.replace(/&(nbsp|lt|gt|quot|#39|apos|amp);/g, (_, e: string) => ENTITIES[e]);

// Without the cell separators (" · ") and spaces at both ends; a loop, as a
// pattern for this backtracks exponentially on rows of empty cells.
function trimCells(text: string) {
  let start = 0,
    end = text.length;
  while (start < end && (text[start] === "·" || /\s/.test(text[start]))) start++;
  while (end > start && (text[end - 1] === "·" || /\s/.test(text[end - 1]))) end--;
  return text.slice(start, end);
}

// The paragraphs of an HTML document as plain text: block elements end a
// paragraph, headings are kept as their own paragraphs (marked), scripts,
// styles and tags disappear.
export function htmlParagraphs(html: string): { text: string; heading: boolean }[] {
  const marked = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h[1-6][^>]*>/gi, "\u0001H")
    .replace(/<\/(p|h[1-6]|li|blockquote|pre|tr|div|figcaption|dt|dd|summary|details|table|ul|ol)>/gi, "\u0001")
    .replace(/<br\s*\/?>/gi, "\u0001")
    .replace(/<\/t[dh]>/gi, " · ")
    .replace(/<[^>]*>/g, " ");
  return marked
    .split("\u0001")
    .map((part) => {
      const heading = part.startsWith("H");
      const text = trimCells(decode(heading ? part.slice(1) : part).replace(/\s+/g, " "));
      return { text, heading };
    })
    .filter((p) => p.text);
}

// Long paragraphs are cut at sentence ends (or spaces) below CHUNK_MAX.
function split(text: string, max = CHUNK_MAX): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("; "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut < max * 0.4) cut = max - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// Paragraphs merged into chunks up to CHUNK_TARGET characters. A heading
// starts a new chunk and is repeated as its first line, so a chunk keeps its
// context.
export function chunkParagraphs(paragraphs: { text: string; heading?: boolean }[], target = CHUNK_TARGET): string[] {
  const chunks: string[] = [];
  let current: string[] = [],
    size = 0,
    heading = "";
  const flush = () => {
    if (current.length && current.some((c) => c !== heading)) chunks.push(current.join("\n"));
    current = heading ? [heading] : [];
    size = heading.length;
  };
  for (const p of paragraphs) {
    if (p.heading) {
      flush();
      heading = p.text.slice(0, 200);
      current = [heading];
      size = heading.length;
      continue;
    }
    for (const piece of split(p.text)) {
      if (size + piece.length > target && current.some((c) => c !== heading)) flush();
      current.push(piece);
      size += piece.length + 1;
    }
  }
  flush();
  return chunks;
}

export const chunkHtml = (html: string, target = CHUNK_TARGET) => chunkParagraphs(htmlParagraphs(html), target);
export const chunkPlain = (text: string, target = CHUNK_TARGET) =>
  chunkParagraphs(
    text
      .split(/\n\s*\n|\r?\n/)
      .map((t) => ({ text: t.replace(/\s+/g, " ").trim() }))
      .filter((p) => p.text),
    target,
  );

// Words that say nothing about the topic (German and English).
const STOPWORDS = new Set(
  (
    "aber alle allem allen aller alles also als am an andere anderen auch auf aus bei beim bin bis bist da damit dann das dass dein deine dem den denn der des dessen die dies diese diesem diesen dieser dieses doch dort du durch ein eine einem einen einer eines er es etwas euch euer gibt gab hab habe haben hat hatte hätte ich ihm ihn ihr ihre im in ins ist ja jede jedem jeden jeder jedes kann kannst kein keine können könnte machen man mehr mein meine mich mir mit muss müssen nach nicht nichts noch nun nur ob oder ohne sehr sein seine sich sie sind so soll sollen sollte über um und uns unser unter vom von vor war waren warum was weil welche welchem welchen welcher welches wenn wer werden wie wieso wir wird wo wurde wurden zu zum zur zwischen bitte gibt steht stehen sagt wann wieviel viele gerade eigentlich " +
    "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your tell show give find list please know"
  ).split(" "),
);

// Normalized for matching: lower case, no diacritics (like the trigram
// index with remove_diacritics).
export const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ß/g, "ss");

// The search terms of a question: words of three letters or more (the
// trigram index needs three), without stop words, at most twelve.
export function questionTerms(question: string): string[] {
  const words = fold(question).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];
  const terms: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/^[-_]+|[-_]+$/g, "");
    if ([...word].length < 3 || STOPWORDS.has(word) || terms.includes(word)) continue;
    terms.push(word.slice(0, 60));
    if (terms.length >= 12) break;
  }
  return terms;
}

// An FTS5 query for the trigram index: any of the terms.
export const ftsQuery = (terms: string[]) => terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");

export type Passage = {
  // The source this passage belongs to (page, or page and record).
  key: string;
  text: string;
  // The source's rank from retrieval (0 = best); added to the text score.
  sourceRank: number;
  // Title of the source; matching terms count a little.
  title: string;
  // Extra score, e.g. for a chunk found by meaning.
  boost?: number;
  // Position of the chunk in its source.
  index?: number;
};
// score: everything; matched: the part from the question's terms alone.
export type RankedPassage = Passage & { score: number; matched: number };

// Scores passages by the question's terms: rarer terms weigh more (an
// inverse document frequency over the candidates), repeated hits count less,
// the source's retrieval rank adds a bonus.
export function rankPassages(passages: Passage[], terms: string[]): RankedPassage[] {
  const folded = passages.map((p) => fold(p.text));
  const titles = passages.map((p) => fold(p.title));
  const n = passages.length || 1;
  const idf = new Map(
    terms.map((t) => {
      const df = folded.filter((text) => text.includes(t)).length;
      return [t, Math.log(1 + n / (1 + df))];
    }),
  );
  return passages
    .map((p, i) => {
      let matched = 0;
      for (const t of terms) {
        const hits = folded[i].split(t).length - 1;
        if (hits) matched += idf.get(t)! * (1 + 0.5 * Math.log(hits));
        if (titles[i].includes(t)) matched += idf.get(t)! * 0.5;
      }
      // Earlier retrieval ranks (full text or meaning) break ties.
      const score = matched + 1 / (1 + p.sourceRank) + (p.boost || 0);
      return { ...p, score, matched };
    })
    .sort((a, b) => b.score - a.score);
}

// The best passages within the budget: at most `perSource` per source and
// `maxSources` sources, in ranked order.
export function selectPassages(ranked: RankedPassage[], budget: number, perSource = 3, maxSources = 8): RankedPassage[] {
  const chosen: RankedPassage[] = [];
  const count = new Map<string, number>();
  let used = 0;
  for (const p of ranked) {
    const already = count.get(p.key) || 0;
    if (already >= perSource) continue;
    if (!already && count.size >= maxSources) continue;
    if (used + p.text.length > budget) continue;
    chosen.push(p);
    count.set(p.key, already + 1);
    used += p.text.length;
  }
  return chosen;
}
