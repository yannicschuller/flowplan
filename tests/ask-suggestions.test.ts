import { test } from "node:test";
import assert from "node:assert/strict";
import { askSuggestions, firstName, modelDisplayName, recentAskPages } from "../lib/ai/ask-suggestions";

// The questions "KI fragen" offers before the first one (components/ai-ask.tsx).

test("an open document: summarise it, then recent pages, the help question last", () => {
  const s = askSuggestions({
    page: { id: "p1", title: "Projektplan", kind: "document" },
    recent: [
      { id: "p1", title: "Projektplan" },
      { id: "p2", title: "Notizen" },
      { id: "p3", title: "Budget" },
      { id: "p4", title: "Archiv" },
    ],
    help: true,
  });
  assert.deepEqual(s, [
    { kind: "summarize", pageId: "p1", title: "Projektplan" },
    { kind: "recent", pageId: "p2", title: "Notizen" },
    { kind: "recent", pageId: "p3", title: "Budget" },
    { kind: "help" },
  ]);
});

test("a database: what is due this week only with a date field", () => {
  const withDate = askSuggestions({ page: { id: "db", title: "Aufgaben", kind: "database", hasDate: true }, recent: [{ id: "x", title: "X" }], help: true });
  assert.deepEqual(withDate.map((s) => s.kind), ["due", "summarize", "recent", "help"]);
  const without = askSuggestions({ page: { id: "db", title: "Aufgaben", kind: "database", hasDate: false }, recent: [], help: true });
  assert.deepEqual(without.map((s) => s.kind), ["summarize", "help"]);
});

test("nothing open, no help: only recent pages, at most two; never more than the maximum", () => {
  assert.deepEqual(
    askSuggestions({ page: null, recent: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }], help: false }).map((s) => s.kind),
    ["recent", "recent"],
  );
  assert.deepEqual(askSuggestions({ page: null, recent: [], help: true }), [{ kind: "help" }]);
  assert.deepEqual(askSuggestions({ page: null, recent: [], help: false }), []);
  assert.equal(askSuggestions({ page: { id: "d", title: "D", kind: "database", hasDate: true }, recent: [{ id: "a", title: "A" }], help: true, max: 2 }).length, 2);
  // A page without a title is not offered by name.
  assert.deepEqual(askSuggestions({ page: { id: "p", title: "  " }, recent: [{ id: "a", title: "" }], help: false }), []);
});

test("recent pages: visits first, then the last changed; only readable documents and databases", () => {
  const pages = [
    { id: "a", title: "Alt", kind: "document", updated_at: "2026-01-01" },
    { id: "b", title: "Neu  geändert", kind: "document", updated_at: "2026-11-01" },
    { id: "c", title: "Besucht", kind: "database", updated_at: "2025-01-01" },
    { id: "d", title: "Gelöscht", kind: "document", deleted_at: "2026-11-02", updated_at: "2026-11-02" },
    { id: "e", title: "Board", kind: "whiteboard", updated_at: "2026-11-03" },
    { id: "f", title: "Gesperrt", kind: "document", updated_at: "2026-11-04" },
    { id: "g", title: "Offen", kind: "document", updated_at: "2026-11-05" },
  ];
  const recent = recentAskPages(pages, [{ pageId: "c", seenAt: 5 }, { pageId: "missing", seenAt: 9 }], { exclude: "g", readable: (id) => id !== "f" });
  assert.deepEqual(recent, [
    { id: "c", title: "Besucht" },
    { id: "b", title: "Neu geändert" },
    { id: "a", title: "Alt" },
  ]);
  assert.deepEqual(recentAskPages(pages, [], { readable: () => false }), []);
});

test("first names for the greeting", () => {
  assert.equal(firstName("Anna Schmidt"), "Anna");
  assert.equal(firstName("  Jo  "), "Jo");
  assert.equal(firstName("anna@example.test"), "");
  assert.equal(firstName(""), "");
  assert.equal(firstName(null), "");
  assert.equal(firstName("12345"), "");
});

test("model ids as readable names", () => {
  const cases: [string, string][] = [
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-sonnet-4", "Sonnet 4"],
    ["claude-3-5-sonnet-latest", "Sonnet 3.5"],
    ["gpt-4.1-mini", "GPT-4.1 mini"],
    ["gpt-4o", "GPT-4o"],
    ["gpt-4o-2024-08-06", "GPT-4o"],
    ["o3", "o3"],
    ["o4-mini", "o4-mini"],
    ["gemini-2.5-flash", "Gemini 2.5 Flash"],
    ["models/gemini-2.0-flash-lite", "Gemini 2.0 Flash Lite"],
    ["llama3.1", "Llama 3.1"],
    ["llama3.1:8b", "Llama 3.1 8B"],
    ["qwen2.5:14b", "Qwen 2.5 14B"],
    ["mistral", "mistral"],
    ["mock-model", "mock-model"],
    ["", ""],
  ];
  for (const [id, name] of cases) assert.equal(modelDisplayName(id), name, id);
});
