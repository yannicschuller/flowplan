// {Inhalt} / {Content} / {Contenu} / {内容}: how an AI property's prompt
// refers to the record's page content (unless a property has that name).
// Shared by the server (lib/ai/database-fields.ts) and the property editor
// (components/ai-database.tsx), so it carries no server imports. German and
// English, then the translation of "Content" in every catalogue in locales/ –
// tests/ai-database.test.ts fails when a catalogue's word is missing here.
export const CONTENT_REFERENCES = ["Inhalt", "Content", "Contenu", "内容"];
// The reference the editor's chip inserts for an unknown word: always parsable.
export const CANONICAL_CONTENT_REFERENCE = "Content";

export const isContentReferenceName = (name: string) => {
  const wanted = name.trim().toLowerCase();
  return CONTENT_REFERENCES.some((c) => c.toLowerCase() === wanted);
};

// The word for the chip: the UI language's own word when the parser knows it.
export const contentReferenceFor = (localized: string) =>
  isContentReferenceName(localized) ? localized.trim() : CANONICAL_CONTENT_REFERENCE;
