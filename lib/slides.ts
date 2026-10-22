// Presentation mode (components/presentation.tsx): how the top-level blocks
// of a document become slides. Each H1 starts a slide – or each H2 when the
// document has no H1 – and a horizontal rule (---) always does. A note
// callout at the very end of a slide holds the speaker notes: hidden on the
// slide, shown in the presenter view.

// One top-level block: its tag name and, for callouts, the kind.
export type SlideBlock = { tag: string; callout?: string | null };
export type SlidePlan = {
  // Indexes of the blocks shown on the slide.
  blocks: number[];
  // The note callout with the speaker notes, if any.
  notes: number | null;
};

const isNote = (block: SlideBlock) =>
  block.tag.toLowerCase() === "aside" && (block.callout === "note" || block.callout === "true");
const isEmpty = (block: SlideBlock & { empty?: boolean }) => !!block.empty;

export function planSlides(blocks: (SlideBlock & { empty?: boolean })[]): SlidePlan[] {
  const tags = blocks.map((b) => b.tag.toLowerCase());
  const level = tags.includes("h1") ? "h1" : tags.includes("h2") ? "h2" : null;
  const groups: number[][] = [[]];
  blocks.forEach((_, i) => {
    const tag = tags[i];
    if (tag === "hr") {
      groups.push([]);
      return;
    }
    if (tag === level && groups[groups.length - 1].length) groups.push([]);
    groups[groups.length - 1].push(i);
  });
  return groups
    .filter((group) => group.some((i) => !isEmpty(blocks[i])))
    .map((group) => {
      // Empty paragraphs after the notes do not hide them.
      let last = group.length - 1;
      while (last > 0 && isEmpty(blocks[group[last]])) last--;
      const notes = last > 0 && isNote(blocks[group[last]]) ? group[last] : null;
      return { blocks: notes === null ? group : group.slice(0, last), notes };
    });
}
