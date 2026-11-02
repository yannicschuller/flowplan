"use client";
// The workspace's tags for multi-select properties whose options they are
// (issue #79): their colours, order and whether the person may create new
// ones (components/cell-input.tsx, components/database-view.tsx).
import { createContext, useContext } from "react";
import { foldName, type PageTag, type PageTagColor } from "@/lib/page-properties";

export type TagOptions = { tags: PageTag[]; createTags: boolean };
export const TagOptionsContext = createContext<TagOptions>({ tags: [], createTags: false });
export const useTagOptions = () => useContext(TagOptionsContext);

// A tag by name (any case) as a chip; unknown names (a guest's view, a tag
// created a moment ago) stay gray until the tags are loaded again.
export function tagByName(tags: PageTag[], name: string): PageTag {
  const folded = foldName(name);
  return tags.find((t) => foldName(t.name) === folded) ?? { id: `name:${name}`, name, color: "gray" as PageTagColor, position: 0 };
}
