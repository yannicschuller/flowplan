"use client";
// "/Seite" in the editor (#444): the workspace shell registers how a
// sub-page is made (offline through the offline queue, encrypted titles,
// records' sub-pages, its own error messages) and how it is opened (the
// frame the editor is in); editors deep below it ask here. Without a
// shell (published pages …) there is none and the entry is not offered.
export type SubPageCreator = {
  // The new page below `hostId` (and its record `rowId`), or null when it
  // could not be made (the shell told why).
  create: (hostId: string, rowId: string | null) => Promise<{ id: string; title: string } | null>;
  // Opens it where `origin` (the editor) is, its title ready for typing.
  open: (id: string, origin: Element | null) => void;
};

let current: SubPageCreator | null = null;
export function setSubPageCreator(creator: SubPageCreator) {
  current = creator;
  return () => {
    if (current === creator) current = null;
  };
}
export const subPageCreator = () => current;
