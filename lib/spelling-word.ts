// The word under the pointer, for the spelling suggestions of the desktop
// app (components/text-menu.tsx asks window.FlowplanDesktop.spelling): its
// letters, with apostrophes and hyphens inside a word ("l'été",
// "Müller-Lüdenscheidt"), and where it starts and ends in the text.
const LETTER = /[\p{L}\p{M}]/u;
const JOINER = /['’-]/;

export function wordAt(text: string, offset: number): { word: string; start: number; end: number } | null {
  if (!text || offset < 0 || offset > text.length) return null;
  const inWord = (i: number) => i >= 0 && i < text.length && (LETTER.test(text[i]) || (JOINER.test(text[i]) && LETTER.test(text[i - 1] || "") && LETTER.test(text[i + 1] || "")));
  // The pointer right after a word still means that word.
  let at = offset;
  if (!inWord(at) && inWord(at - 1)) at -= 1;
  if (!inWord(at)) return null;
  let start = at;
  let end = at + 1;
  while (inWord(start - 1)) start -= 1;
  while (inWord(end)) end += 1;
  const word = text.slice(start, end);
  // Spell checkers know words, not numbers or whole sentences.
  if (word.length > 64 || !LETTER.test(word[0])) return null;
  return { word, start, end };
}
