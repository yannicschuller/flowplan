// What the AI flashcards (lib/ai/flashcards.ts) and their dialog
// (components/study/ai-cards.tsx) share. Client-safe: no server imports.

export const AI_CARD_TYPES = ["basic", "cloze", "typed", "choice"] as const;
export type AiCardType = (typeof AI_CARD_TYPES)[number];
// Cards of one run at most.
export const AI_CARDS_MAX = 200;

export type CardSuggestion = {
  id: string;
  type: AiCardType;
  front: string;
  back: string;
  hint?: string;
  // Multiple choice: the wrong options.
  choices?: string[];
  tags?: string[];
  // The heading or passage of the source the card is based on.
  source?: string;
  // Marks for the review: similar to a card of the deck or an earlier
  // suggestion, a yes/no question.
  duplicate?: boolean;
  yesNo?: boolean;
};

export type FlashcardSourceInput =
  | { kind: "page"; pageId: string; rowId?: string | null }
  | { kind: "selection"; pageId: string; rowId?: string | null; text: string }
  // `text`: the text of some of a PDF's pages, read in the browser (the
  // page range of the dialog or the PDF viewer); without it the file's
  // whole extracted text.
  | { kind: "file"; fileId: string; text?: string; pages?: { from: number; to: number } }
  | { kind: "text"; text: string };

export type ProposeCardsResult = {
  cards: CardSuggestion[];
  parts: number;
  chars: number;
  tokens: number;
  title: string;
  deck: { id: string; title: string } | null;
};
