// A local Ollama-compatible provider for tests: /api/chat answers with what
// `answer` returns (as an NDJSON stream), /api/embed with `vector`. Every
// request is recorded, so tests can check what reached the "model".
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type ChatRequest = { model: string; system: string; messages: { role: string; content: string }[]; prompt: string };
export type OllamaMock = {
  base: string;
  chats: ChatRequest[];
  embeds: string[][];
  answer: (request: ChatRequest, index: number) => string;
  vector: (text: string) => number[];
  close: () => Promise<void>;
};

export async function startOllamaMock(): Promise<OllamaMock> {
  const mock: OllamaMock = {
    base: "",
    chats: [],
    embeds: [],
    answer: () => "OK",
    vector: (text) => [text.length % 7, 1, 0],
    close: async () => {},
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (req.url === "/api/chat") {
        const messages = (body.messages || []) as { role: string; content: string }[];
        const request: ChatRequest = {
          model: body.model,
          system: messages.find((m) => m.role === "system")?.content || "",
          messages: messages.filter((m) => m.role !== "system"),
          prompt: messages.map((m) => m.content).join("\n"),
        };
        mock.chats.push(request);
        const text = mock.answer(request, mock.chats.length - 1);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { role: "assistant", content: text }, done: false }) + "\n");
        res.end(JSON.stringify({ done: true }) + "\n");
        return;
      }
      if (req.url === "/api/embed") {
        const input = body.input as string[];
        mock.embeds.push(input);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings: input.map((t) => mock.vector(t)) }));
        return;
      }
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "chat" }, { name: "embed" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mock.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise((resolve) => server.close(() => resolve()));
  return mock;
}
