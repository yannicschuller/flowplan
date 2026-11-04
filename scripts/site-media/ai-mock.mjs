// A stand-in AI provider for screenshots and clips: an OpenAI-compatible
// server on 127.0.0.1 that streams canned, plausible answers – no model, no
// key, the same answer every time. seed.mjs points the instance at it.
//
//   MOCK_PORT=3299 node scripts/site-media/ai-mock.mjs
//
// Ask AI: the answer cites the numbered sources of the request by their
// titles, so the numbers always point at the right pages.
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT || 3299);
const DELAY = Number(process.env.MOCK_DELAY || 35);

// [title pattern, …] → the source number with that title, as "[n]".
const cite = (sources, ...patterns) =>
  patterns
    .map((p) => sources.find((s) => p.test(s.title))?.n)
    .filter(Boolean)
    .map((n) => `[${n}]`)
    .join("");

const ANSWERS = [
  {
    // Ask AI about the launch (English and German).
    test: (all, system) => /Fragen zu den Inhalten/.test(system) && /launch|Launch|Start/i.test(all),
    text: (sources, english, last) => {
      // The date as the launch plan states it ("Launch: Thursday 12 November.").
      const day = last.match(/(?:Launch|Start): (?:\*\*)?([^.*<]+?)\./)?.[1] || (english ? "the launch day" : "dem Starttag");
      return english
        ? `The public launch is on **${day}** ${cite(sources, /^Launch plan/)}. The go/no-go review is the day before; Mia makes the call ${cite(sources, /Launch sync/)}.\n\nIt depends on two things, both owned by Jonas ${cite(sources, /Launch sync/, /Product launch/)}:\n\n- the **migration dry run**\n- the **beta rollout** to the beta customers`
        : `Der öffentliche Start ist am **${day}** ${cite(sources, /^Launch|Startplan/)}. Am Tag davor ist das Go/No-go; Mia entscheidet ${cite(sources, /Abstimmung|sync/i)}.\n\nAbhängig ist er von zwei Dingen, beide bei Jonas:\n\n- dem **Probelauf der Migration**\n- dem **Beta-Rollout** an die Testkunden`;
    },
  },
  {
    // Writing assistant: "Shorten".
    test: (all) => /Shorten the text|Kürze/i.test(all),
    // The date as the selected text states it ("goes live on 12 November").
    text: (_s, english, last) => {
      const day = last.match(/(?:goes live on|startet am|geht am) ([^.,:]+?)(?:[.,:]| live)/)?.[1];
      return english
        ? `Flowplan 2.0 launches ${day ? `on ${day} ` : ""}in stages: beta customers get it first, everyone else about a week later. Marketing, support and docs go live together, and Mia makes the go/no-go call the day before.`
        : `Flowplan 2.0 startet ${day ? `am ${day} ` : ""}in Stufen: zuerst die Beta-Kunden, eine Woche später alle anderen. Marketing, Support und Doku gehen gemeinsam live; Mia entscheidet am Vortag über das Go.`;
    },
  },
  {
    // Ask AI, anything else.
    test: (_all, system) => /Fragen zu den Inhalten/.test(system),
    text: (sources, english) =>
      english
        ? `Here is what the pages say ${sources.slice(0, 2).map((s) => `[${s.n}]`).join("")}.`
        : `Das steht dazu in den Seiten ${sources.slice(0, 2).map((s) => `[${s.n}]`).join("")}.`,
  },
];

function answer(body) {
  const messages = body.messages || [];
  const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  const system = messages.filter((m) => m.role === "system").map(text).join("\n") + (typeof body.system === "string" ? body.system : "");
  const all = messages.map(text).join("\n");
  const last = text(messages.filter((m) => m.role === "user").at(-1) || { content: "" });
  const sources = [...last.matchAll(/<quelle nr="(\d+)"[^>]*titel="([^"]*)"/g)].map((m) => ({ n: Number(m[1]), title: m[2] }));
  // The question comes after the sources.
  const question = last.replace(/<quelle[\s\S]*?<\/quelle>/g, "");
  const english = !/[äöüß]|\b(der|die|das|ist|wann|und|wovon)\b/i.test(question);
  for (const a of ANSWERS) if (a.test(all, system)) return a.text(sources, english, last);
  return english ? "Done." : "Erledigt.";
}

const tokens = (text) => text.match(/\S+\s*|\s+/g) || [];

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {}
    const url = req.url || "";
    if (url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "llama3.1" }, { id: "nomic-embed-text" }] }));
      return;
    }
    if (url.endsWith("/embeddings")) {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: 8 }, (_, i) => (i === index % 8 ? 1 : 0)) })) }));
      return;
    }
    if (url.endsWith("/chat/completions")) {
      const text = answer(body);
      console.log(new Date().toISOString(), "chat →", text.slice(0, 60).replace(/\n/g, " "));
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const t of tokens(text)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, DELAY));
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
}).listen(PORT, "127.0.0.1", () => console.log("AI mock on", PORT));
