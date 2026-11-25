// What "KI fragen" offers before the first question (components/ai-ask.tsx):
// a greeting with the person's first name and a few questions that fit what
// is open and what they looked at last – computed from what the workspace
// already has loaded, no request and no AI call. Also the short, readable
// name of the model ("Opus 5.5") for the composer's pill.

// The open page as far as the suggestions need it (only when the AI may read
// it and it can go along: components/ai-ask.tsx `pageOffered`).
export type SuggestPage = { id: string; title: string; kind?: string; hasDate?: boolean };
export type SuggestRecent = { id: string; title: string };
export type AskSuggestion =
  // „Fasse „X“ zusammen“ – the page goes along ("Diese Seite").
  | { kind: "summarize"; pageId: string; title: string }
  // „Was ist diese Woche fällig?“ – a database with a date field, it goes along.
  | { kind: "due"; pageId: string; title: string }
  // „Was steht in „X“?“ – a page looked at recently, found by the search.
  | { kind: "recent"; pageId: string; title: string }
  // A question about Flowplan itself, answered from the help.
  | { kind: "help" };

export const ASK_SUGGESTIONS_MAX = 4;

export function askSuggestions(input: { page: SuggestPage | null; recent: SuggestRecent[]; help: boolean; max?: number }): AskSuggestion[] {
  const max = Math.max(0, input.max ?? ASK_SUGGESTIONS_MAX);
  const out: AskSuggestion[] = [];
  const page = input.page;
  if (page?.title.trim()) {
    if (page.kind === "database" && page.hasDate) out.push({ kind: "due", pageId: page.id, title: page.title });
    out.push({ kind: "summarize", pageId: page.id, title: page.title });
  }
  // The help question keeps its place at the end.
  const room = max - out.length - (input.help ? 1 : 0);
  const seen = new Set(page ? [page.id] : []);
  for (const r of input.recent) {
    if (out.filter((s) => s.kind === "recent").length >= Math.min(2, room)) break;
    if (seen.has(r.id) || !r.title.trim()) continue;
    seen.add(r.id);
    out.push({ kind: "recent", pageId: r.id, title: r.title });
  }
  if (input.help) out.push({ kind: "help" });
  return out.slice(0, max);
}

// The pages looked at last that a question can be about: newest visit
// first, then the last changed pages to fill up – documents and databases
// the AI may read, nothing deleted, nothing in the trash, not the open one.
export function recentAskPages(
  pages: { id: string; title: string; kind: string; deleted_at?: string | null; updated_at?: string; synced?: number; offline?: string }[],
  visits: { pageId: string; seenAt: number }[],
  options: { exclude?: string | null; readable: (pageId: string) => boolean; limit?: number },
): SuggestRecent[] {
  const limit = options.limit ?? 3;
  const usable = new Map(
    pages
      .filter((p) => !p.deleted_at && !p.synced && !p.offline && (p.kind === "document" || p.kind === "database") && p.title.trim() && p.id !== options.exclude && options.readable(p.id))
      .map((p) => [p.id, p]),
  );
  const out: SuggestRecent[] = [];
  const push = (id: string) => {
    const p = usable.get(id);
    if (!p || out.some((o) => o.id === id) || out.length >= limit) return;
    out.push({ id, title: p.title.replace(/\s+/g, " ").trim() });
  };
  for (const v of [...visits].sort((a, b) => b.seenAt - a.seenAt)) push(v.pageId);
  for (const p of [...usable.values()].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))) push(p.id);
  return out;
}

// The first name for the greeting: the first word of the name, nothing for
// an address or an empty name.
export function firstName(name: string | null | undefined): string {
  const word = String(name || "").trim().split(/\s+/)[0] || "";
  if (!word || word.includes("@") || !/\p{L}/u.test(word)) return "";
  return word.length > 24 ? "" : word;
}

// A model id as people read it: "claude-opus-5-5" → "Opus 5.5",
// "gpt-4.1-mini" → "GPT-4.1 mini", "gemini-2.5-flash" → "Gemini 2.5 Flash",
// "llama3.1:8b" → "Llama 3.1 8B". Anything unknown stays as it is (without
// a "models/" prefix or a date suffix).
export function modelDisplayName(model: string | null | undefined): string {
  let id = String(model || "").trim().replace(/^models\//, "");
  if (!id) return "";
  // Date suffixes: claude-…-20250929, gpt-4o-2024-08-06, …-latest.
  id = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/i, "");
  const lower = id.toLowerCase();
  const word = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  // claude-opus-5-5, claude-sonnet-4, claude-haiku-4-5
  let m = lower.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?$/);
  if (m) return `${word(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  // claude-3-5-sonnet, claude-3-opus
  m = lower.match(/^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)$/);
  if (m) return `${word(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ""}`;
  // gpt-4.1-mini, gpt-4o, gpt-5
  m = lower.match(/^gpt-([\w.]+?)(?:-(mini|nano|pro|turbo))?$/);
  if (m) return `GPT-${m[1]}${m[2] ? ` ${m[2]}` : ""}`;
  // gemini-2.5-flash, gemini-2.0-pro-exp
  m = lower.match(/^gemini-([\d.]+)-([a-z-]+)$/);
  if (m) return `Gemini ${m[1]} ${m[2].split("-").map(word).join(" ")}`;
  // OpenAI's reasoning models stay as they are: o3, o4-mini.
  if (/^o\d/.test(lower)) return id;
  // Ollama: llama3.1, llama3.1:8b, qwen2.5:14b, mistral, gemma3:4b
  m = lower.match(/^([a-z]+)([\d.]*)(?::(\d+(?:\.\d+)?)b)?$/);
  if (m && (m[2] || m[3])) return `${word(m[1])}${m[2] ? ` ${m[2]}` : ""}${m[3] ? ` ${m[3]}B` : ""}`;
  return id;
}
// The family alone where Claude's naming has one ("Opus", "Sonnet",
// "Haiku") – for "Bis Opus – frei wählbar" (#538); else the display name.
export function modelFamilyName(model: string | null | undefined): string {
  const lower = String(model || "").toLowerCase();
  for (const f of ["opus", "sonnet", "haiku"]) if (lower.includes(f)) return f.charAt(0).toUpperCase() + f.slice(1);
  return modelDisplayName(model) || String(model || "");
}
