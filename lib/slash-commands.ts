// The "/" block menu: filtering ("/h2", "/todo" or "/tab" find their block by
// name, short alias or description; the best match comes first so Enter picks
// it), the sections of the menu and the recently used blocks.
export type SlashGroup =
  | "recent"
  | "ai"
  | "text"
  | "lists"
  | "blocks"
  | "media"
  | "math"
  | "database"
  | "advanced";
// The order of the sections when nothing is typed.
export const SLASH_GROUPS: SlashGroup[] = ["ai", "text", "lists", "blocks", "media", "math", "database", "advanced"];

export type SlashCommand = {
  // Stable identifier, remembered as recently used ("h2", "callout-tip" …).
  id?: string;
  name: string;
  description: string;
  keywords: string[];
  group?: SlashGroup;
  // A second level: choosing the entry shows these instead of inserting
  // (the callout kinds). They are also found directly when typing.
  children?: SlashCommand[];
};

export type SlashSection<T extends SlashCommand> = { group: SlashGroup; items: T[] };

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "");

function score(command: SlashCommand, query: string) {
  const name = normalize(command.name),
    words = command.name.split(/[\s-]+/).map(normalize),
    keywords = command.keywords.map(normalize),
    description = normalize(command.description);
  if (keywords.includes(query) || name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (keywords.some((k) => k.startsWith(query))) return 2;
  if (words.some((w) => w.startsWith(query))) return 3;
  if (name.includes(query) || keywords.some((k) => k.includes(query)))
    return 4;
  if (description.includes(query)) return 5;
  return -1;
}

export function rankCommands<T extends SlashCommand>(
  commands: T[],
  query: string,
): T[] {
  const q = normalize(query);
  if (!q) return commands;
  return commands
    .map((command, index) => ({ command, index, rank: score(command, q) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}

// Every command and every second-level entry, in menu order.
export function flattenCommands<T extends SlashCommand>(commands: T[]): T[] {
  return commands.flatMap((command) => [command, ...((command.children as T[] | undefined) || [])]);
}

// The sections of the menu. Without a query: the recently used blocks first,
// then every group in its order. With a query: the matches (second-level
// entries included, so "/tip" finds the tip callout right away) grouped, the
// groups ordered by their best match, so the first entry is the best one.
export function slashSections<T extends SlashCommand>(
  commands: T[],
  query: string,
  recents: string[] = [],
): SlashSection<T>[] {
  if (!query.trim()) {
    const sections: SlashSection<T>[] = [];
    const all = flattenCommands(commands);
    const recent = recents
      .map((id) => all.find((command) => command.id === id))
      .filter((command): command is T => !!command)
      .slice(0, MAX_RECENTS);
    if (recent.length) sections.push({ group: "recent", items: recent });
    for (const group of SLASH_GROUPS) {
      const items = commands.filter((command) => (command.group || "advanced") === group);
      if (items.length) sections.push({ group, items });
    }
    return sections;
  }
  const ranked = rankCommands(flattenCommands(commands), query);
  const sections: SlashSection<T>[] = [];
  for (const command of ranked) {
    const group = command.group || "advanced";
    const section = sections.find((s) => s.group === group);
    if (section) section.items.push(command);
    else sections.push({ group, items: [command] });
  }
  return sections;
}

// Recently used blocks, kept in this browser.
export const MAX_RECENTS = 5;
const RECENTS_KEY = "flowplan.slash-recents";
export function readSlashRecents(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}
export function rememberSlashCommand(id: string, current = readSlashRecents()): string[] {
  const next = [id, ...current.filter((other) => other !== id)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {}
  return next;
}
