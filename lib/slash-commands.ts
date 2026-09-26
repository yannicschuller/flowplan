// Filtering for the "/" block menu: "/h2", "/todo" or "/tab" find their block
// by name, short alias or description; the best match comes first so Enter
// picks it.
export type SlashCommand = {
  name: string;
  description: string;
  keywords: string[];
};

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
