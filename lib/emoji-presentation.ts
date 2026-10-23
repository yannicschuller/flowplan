// emojibase-data 18 follows emoji-test.txt: an emoji that already defaults
// to emoji presentation carries no U+FE0F (👍️ → 👍, ⌚️ → ⌚). Reactions
// stored or sent in the older form are read in the new one, so they still
// match the picker and toggle the same reaction.
export const emojiPresentation = (value: string) =>
  value.replace(/^(\p{Emoji_Presentation})️$/u, "$1");
