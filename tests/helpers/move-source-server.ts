// A second Flowplan instance for tests/instance-move.test.ts: its own data
// folder in its own process, with a page and an upload, a move token, and
// the move endpoints (app/api/move) behind an HTTP server. Prints one line of
// JSON ({ url, token, pageId, fileId }) once it listens; GET /state answers
// with its read-only state.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "flowplan-move-source-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.APP_URL = "https://source.example.test";
const { run, id } = await import("../../lib/db");
const { createWorkspace } = await import("../../lib/seed");
const { command, bootstrap } = await import("../../lib/api");
const move = await import("../../lib/instance-move");
const { readOnlyState } = await import("../../lib/instance-read-only");
const route = await import("../../app/api/move/[...path]/route");

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `source:${uid}`, "Quelle", `${uid}@example.test`);
const owner = { id: uid, name: "Quelle", email: `${uid}@example.test`, groups: ["flowplan-admins"], isAdmin: true, disabled: 0, created_at: "" } as never;
const wid = createWorkspace(uid, "Quelle");
const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: bootstrap(owner, wid).spaces[0].id, title: "Auf der Quelle" }) as { id: string }).id;
mkdirSync(join(dir, "uploads"), { recursive: true });
const fileId = id();
writeFileSync(join(dir, "uploads", fileId), "Datei der Quelle");
const { token } = move.prepareMove(owner);

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1");
  if (url.pathname === "/state") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(readOnlyState()));
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
  const path = url.pathname.replace(/^\/api\/move\//, "").split("/").filter(Boolean);
  const response = await (req.method === "POST" ? route.POST : route.GET)(request, { params: Promise.resolve({ path }) });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, pageId, fileId })}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
