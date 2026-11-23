// The explanation of a storage limit made of a base and add-on groups
// (lib/user-limits.ts), e.g. "25 GB aus Gruppe Flowplan Plus + 50 GB aus
// Gruppe Flowplan +50 GB". Pure, for "Deine Grenzen" and the
// administration's account panel.
import type { LimitSource } from "./user-limits";

type T = (de: string, en: string) => string;

// Whole gigabytes as GB, everything else in MB.
export function storageSizeText(mb: number, tag: string) {
  return mb >= 1024 && mb % 1024 === 0 ? `${(mb / 1024).toLocaleString(tag)} GB` : `${mb.toLocaleString(tag)} MB`;
}

// null without add-ons: the caller's usual "aus Gruppe …" applies.
export function explainStorage(source: LimitSource | undefined, t: T, name: (group: string | null) => string, tag: string): string | null {
  if (!source?.addons?.length || source.base === undefined) return null;
  const base = storageSizeText(source.base, tag);
  const first = source.from === "group" ? t(`${base} aus Gruppe ${name(source.group)}`, `${base} from group ${name(source.group)}`) : t(`${base} Standard`, `${base} default`);
  const more = source.addons.map((a) => {
    const size = storageSizeText(a.mb, tag);
    return t(`+ ${size} aus Gruppe ${name(a.group)}`, `+ ${size} from group ${name(a.group)}`);
  });
  return [first, ...more].join(" ");
}
