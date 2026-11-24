"use client";
// Database choices grouped by space (#520, lib/database-labels.ts). The
// workspace provides its spaces (in the sidebar's order) and the pages the
// person can see; the pickers only label and order what they list.
import { createContext, useContext, useMemo } from "react";
import { databaseList, groupDatabases, type DatabaseEntry, type DatabaseGroup, type DatabaseRef, type PageRef, type SpaceRef } from "@/lib/database-labels";
import { useT } from "./i18n";

export type DatabaseLabelsSource = { spaces: SpaceRef[]; pages: PageRef[] };
export const DatabaseLabelsContext = createContext<DatabaseLabelsSource>({ spaces: [], pages: [] });

export function useDatabaseGroups(databases: DatabaseRef[], source?: Partial<DatabaseLabelsSource>): DatabaseGroup[] {
  const t = useT();
  const known = useContext(DatabaseLabelsContext);
  const spaces = source?.spaces || known.spaces,
    pages = source?.pages || known.pages;
  const untitled = t("Ohne Titel", "Untitled");
  return useMemo(() => groupDatabases(databases, { pages, spaces, untitled }), [databases, pages, spaces, untitled]);
}

// The same as one list (radio lists, buttons): space by space, by title.
export function useDatabaseEntries(databases: DatabaseRef[], source?: Partial<DatabaseLabelsSource>): DatabaseEntry[] {
  const groups = useDatabaseGroups(databases, source);
  return useMemo(() => databaseList(groups), [groups]);
}

// The <option>s of a native select: one <optgroup> per space when there is
// more than one. The chosen database reads "Notizen · Familie" when its
// title repeats elsewhere, so a closed (or disabled) select names it apart.
export function DatabaseOptions({ groups, selected }: { groups: DatabaseGroup[]; selected?: string }) {
  const options = (g: DatabaseGroup) =>
    g.databases.map((d) => (
      <option key={d.id} value={d.id}>
        {d.id === selected ? d.fullLabel : d.label}
      </option>
    ));
  if (groups.length < 2) return <>{groups.map(options)}</>;
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.spaceId || "-"} label={g.space || "–"}>
          {options(g)}
        </optgroup>
      ))}
    </>
  );
}
