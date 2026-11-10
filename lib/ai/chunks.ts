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

// Marks a heading's paragraph: a control character, never text.
const HEADING = "\u0002";
// The paragraphs of an HTML document as plain text: block elements end a
// paragraph, headings are kept as their own paragraphs (marked), scripts,
// styles and tags disappear.
export function htmlParagraphs(html: string): { text: string; heading: boolean }[] {
  const marked = html
    .replace(/[\u0001\u0002]/g, " ")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h[1-6][^>]*>/gi, "\u0001" + HEADING)
    .replace(/<\/(p|h[1-6]|li|blockquote|pre|tr|div|figcaption|dt|dd|summary|details|table|ul|ol)>/gi, "\u0001")
    .replace(/<br\s*\/?>/gi, "\u0001")
    .replace(/<\/t[dh]>/gi, " · ")
    .replace(/<[^>]*>/g, " ");
  return marked
    .split("\u0001")
    .map((part) => {
      const heading = part.startsWith(HEADING);
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
// context; a heading without text after it is a chunk of its own.
export function chunkParagraphs(paragraphs: { text: string; heading?: boolean }[], target = CHUNK_TARGET): string[] {
  const chunks: string[] = [];
  let current: string[] = [],
    size = 0,
    heading = "",
    // The current heading is in a chunk already.
    used = false;
  const flush = () => {
    if (current.some((c) => c !== heading)) chunks.push(current.join("\n"));
    else if (heading && !used) chunks.push(heading);
    used = true;
    current = heading ? [heading] : [];
    size = heading.length;
  };
  for (const p of paragraphs) {
    if (p.heading) {
      flush();
      heading = p.text.slice(0, 200);
      used = false;
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
// index with remove_diacritics). Only the Latin, Greek and Cyrillic accents
// go; other marks are part of the letter (Japanese voicing marks, Thai
// vowels and tones), and Hangul syllables are composed again – the index
// keeps those as written.
export const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]+/g, "")
    .normalize("NFC")
    .replace(/ß/g, "ss");

// Scripts written without spaces between words (or, for Korean, with
// particles attached to them): their words come from the Unicode word
// segmenter instead.
const SEGMENTED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}]/u;
const HANGUL = /\p{scx=Hangul}/u;

// Particles and question words of Chinese (simplified and traditional),
// Japanese, Korean and Thai, as the segmenter returns them.
const SEGMENTED_STOPWORDS = new Set(
  (
    "的 地 得 了 着 过 在 是 和 与 及 跟 同 或 或者 还是 以及 吗 呢 吧 啊 呀 么 嘛 哪 哪里 哪儿 什么 怎么 怎样 怎么样 如何 为什么 为何 谁 几 多少 何时 什么时候 " +
    "这 那 这个 那个 这些 那些 这里 那里 我 你 您 他 她 它 我们 你们 他们 我的 你的 您的 他的 她的 我们的 有 没有 没 不 请 能 能够 可以 会 要 想 需要 一个 个 也 就 还 又 被 把 给 从 到 对 为 向 " +
    "里 中 上 下 之 其 所有 关于 告诉 显示 找 查找 一下 吗 嗎 哪裡 什麼 怎麼 怎樣 為什麼 這 這個 這些 這裡 那裡 們 我們 你們 他們 沒有 與 請 給 對 為 關於 顯示 " +
    "の は が を に で と も へ や か な ね よ から まで より です ます でした ました ある あり ありますか いる する して ください 教え 教えて どこ なに 何 いつ だれ 誰 どう どうやって どれ どの なぜ この その あの これ それ あれ について " +
    "어디 무엇 뭐 언제 어떻게 왜 누가 누구 무슨 어느 있나요 있어요 있습니까 있는 입니까 인가요 이에요 예요 알려 주세요 그리고 또는 " +
    "อยู่ ที่ไหน ไหน อะไร ไหม มั้ย ครับ ค่ะ คะ คือ ที่ และ หรือ ของ ใน มี เป็น อย่างไร ยังไง เมื่อไร เมื่อไหร่ ทำไม ใคร นี้ นั้น"
  ).split(" "),
);
// Korean particles at the end of a word ("청구서는" → "청구서").
const HANGUL_PARTICLE = /(에서|에게|으로|부터|까지|처럼|보다|의|은|는|이|가|을|를|에|로|와|과|도|만)$/u;

let segmenter: Intl.Segmenter | undefined;
// The words of a run in those scripts: segmented, without particles; single
// characters join their neighbours ("浦东/新/区" → "浦东新区", "請求/書" →
// "請求書"), a single character alone says too little.
function segmentedTerms(run: string): string[] {
  segmenter ??= new Intl.Segmenter("zh", { granularity: "word" });
  const terms: string[] = [];
  let group = "",
    lastLength = 0;
  const close = () => {
    if ([...group].length >= 2) terms.push(group);
    group = "";
    lastLength = 0;
  };
  for (const { segment, isWordLike } of segmenter.segment(run)) {
    if (!isWordLike) {
      close();
      continue;
    }
    let word = segment;
    if (HANGUL.test(word) && [...word].length > 2) word = word.replace(HANGUL_PARTICLE, "");
    if (SEGMENTED_STOPWORDS.has(word) || SEGMENTED_STOPWORDS.has(segment)) {
      close();
      continue;
    }
    if (!SEGMENTED.test(word)) {
      // Digits or Latin letters inside the run: as in other text.
      close();
      if ([...word].length >= 3 && !STOPWORDS.has(word)) terms.push(word);
      continue;
    }
    const length = [...word].length;
    if (group && (length === 1 || lastLength === 1)) group += word;
    else {
      close();
      group = word;
    }
    lastLength = length;
  }
  close();
  return terms;
}

// Terms shorter than the trigram index's three characters (two-character
// words of those scripts): found by a bounded scan instead of MATCH.
export const isShortTerm = (term: string) => [...term].length < 3;

// The search terms of a question: words of three letters or more (the
// trigram index needs three), without stop words, at most twelve. Chinese,
// Japanese, Korean and Thai are split into words by the segmenter; there
// two characters make a word (isShortTerm).
export function questionTerms(question: string): string[] {
  const words = fold(question).match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*/gu) || [];
  const terms: string[] = [];
  const add = (term: string) => {
    term = term.slice(0, 60);
    if (!terms.includes(term)) terms.push(term);
  };
  for (const raw of words) {
    const word = raw.replace(/^[-_]+|[-_]+$/g, "");
    if (SEGMENTED.test(word)) segmentedTerms(word).forEach(add);
    else if ([...word].length >= 3 && !STOPWORDS.has(word)) add(word);
    if (terms.length >= 12) break;
  }
  return terms.slice(0, 12);
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
