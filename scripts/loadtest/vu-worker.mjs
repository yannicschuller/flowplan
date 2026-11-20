// One worker thread of the load generator (scripts/loadtest/run.mjs): runs a
// share of the virtual users and reports latencies to the main thread.
//
// Two kinds of virtual users:
// - "reader/writer" users loop over a weighted mix of HTTP requests with a
//   think time in between (bootstrap, opening pages and the database,
//   filtered database queries, search, record edits, new pages, comments);
// - "editors" keep a document open like the web editor does
//   (components/editor.tsx): the live channel (server-sent events,
//   /api/documents/live), keystrokes at a human rate as Yjs updates sent
//   with document.sync 80 ms after typing (one request in flight, the rest
//   batched), and cursor updates (/api/presence; --presence poll and push
//   do what the web editor does, lib/collaboration-cursors.ts, before and
//   since #383 wave 4). Editors of the same
//   document run in the same worker, so the time from one editor's save to
//   the update arriving at the others (fan-out) can be measured;
// - "idle" users are a signed-in tab nobody touches
//   (components/workspace-app.tsx): every 10 s the bootstrap and the open
//   page (a document, every --idle-db-share-th one the task database), each
//   with the ETag of the last answer (If-None-Match), so most answers are a
//   304. With --idle-mode push they do what the app does with the
//   workspace's live signal (/api/live, components/use-workspace-signals.ts):
//   the stream open, the bootstrap or the page only when a signal names it,
//   the bootstrap every 60 s as the safety net and the page every 30 s
//   (it keeps the tab present on the page);
// - "board" users have a whiteboard open (components/whiteboard): the live
//   cursors' stream (/api/whiteboards/:id/cursors) and their pointer moving
//   in bursts, sent up to ~15 times a second (/api/whiteboards/:id/cursor;
//   with --presence push only while someone else has the board open).
import { parentPort, workerData } from "node:worker_threads";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";

const { seed, options, workerIndex, workerCount } = workerData;
const origin = seed.origin;
const TIMEOUT = options.timeout;

// --- Recording ------------------------------------------------------------
let samples = new Map(); // scenario → { lat: number[], ok, err: {kind: n} }
function bucket(name) {
  let b = samples.get(name);
  if (!b) samples.set(name, (b = { lat: [], ok: 0, err: {} }));
  return b;
}
function record(name, ms, error) {
  const b = bucket(name);
  if (error) b.err[error] = (b.err[error] || 0) + 1;
  else {
    b.ok++;
    b.lat.push(ms);
  }
}
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

function classify(status) {
  if (status === 429) return "429";
  if (status === 409) return "409";
  if (status >= 500) return "5xx";
  return "4xx";
}

// One timed request; the body is read (and parsed only when asked for).
async function request(name, path, { method = "GET", body, cookie, token, json = false, headers = {}, etag = false } = {}) {
  const start = performance.now();
  try {
    const response = await fetch(origin + path, {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const data = json ? await response.json().catch(() => null) : await response.arrayBuffer();
    const ms = performance.now() - start;
    if (response.status === 304) {
      record(`${name}.304`, ms);
      return { ok: true, status: 304, data: null, etag: response.headers.get("etag") };
    }
    if (!response.ok) {
      record(name, ms, classify(response.status));
      return { ok: false, status: response.status, data };
    }
    record(name, ms);
    return { ok: true, status: response.status, data, ...(etag ? { etag: response.headers.get("etag") } : {}) };
  } catch (e) {
    const ms = performance.now() - start;
    record(name, ms, e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "network");
    return { ok: false, status: 0 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const WORDS = ["projekt", "release", "kunde", "budget", "sprint", "migration", "backup", "roadmap", "analyse", "termin", "server", "vertrag"];

// Records this worker edits: a disjoint share, so the version cache stays
// right (another worker never changes them).
const myRows = seed.rows.filter((_, i) => i % workerCount === workerIndex).map((r) => ({ ...r }));

// --- Request mix -------------------------------------------------------------
// Weights of the request mix; --mix "name=weight,…" on the runner overrides them.
const DEFAULT_MIX = [
  ["bootstrap", 15],
  ["page.open", 20],
  ["db.open", 8],
  ["db.query", 10],
  ["search", 12],
  ["row.update", 15],
  ["row.create", 4],
  ["page.create", 4],
  ["comment.create", 12],
];
const MIX = options.mix
  ? options.mix.split(",").map((part) => {
      const [name, weight] = part.split("=");
      if (!DEFAULT_MIX.some(([n]) => n === name)) throw new Error(`unknown scenario in --mix: ${name}`);
      return [name, Number(weight)];
    })
  : DEFAULT_MIX;
const MIX_TOTAL = MIX.reduce((s, [, w]) => s + w, 0);
const READS = new Set(["bootstrap", "page.open", "db.open", "db.query", "search"]);
function pickAction() {
  let r = Math.random() * MIX_TOTAL;
  for (const [name, w] of MIX) if ((r -= w) < 0) return name;
  return MIX[0][0];
}

async function action(vu, name) {
  const cookie = vu.user.cookie;
  switch (name) {
    case "bootstrap":
      return request(name, `/api/bootstrap?workspace=${seed.workspaceId}`, { cookie });
    case "page.open":
      return request(name, `/api/pages/${pick(seed.docIds)}`, { cookie, headers: { "x-flowplan-visit": "1" } });
    case "db.open":
      return request(name, `/api/pages/${seed.databaseId}`, { cookie, headers: { "x-flowplan-visit": "1" } });
    case "db.query":
      return request(name, "/api/mcp", {
        method: "POST",
        token: vu.user.token,
        headers: { accept: "application/json, text/event-stream" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "query_database", arguments: { databaseId: seed.databaseId, viewId: pick(["open-high", "big"]), limit: 50, offset: Math.floor(Math.random() * 4) * 50 } },
        },
      });
    case "search":
      return request(name, `/api/search?workspace=${seed.workspaceId}&q=${pick(WORDS)}`, { cookie });
    case "row.update": {
      const row = pick(myRows);
      const field = pick(["status", "estimate", "notes"]);
      const value = field === "status" ? pick(["Offen", "In Arbeit", "Review", "Erledigt"]) : field === "estimate" ? Math.floor(Math.random() * 13) : `${pick(WORDS)} ${Date.now()}`;
      const base = { [field]: row.cells[field] };
      const result = await request(name, "/api/command", {
        method: "POST",
        cookie,
        body: { action: "row.update", pageId: seed.databaseId, rowId: row.id, version: row.version, base, cells: { [field]: value } },
      });
      if (result.ok) {
        row.version++;
        row.cells[field] = value;
      }
      return result;
    }
    case "row.create":
      return request(name, "/api/command", {
        method: "POST",
        cookie,
        body: { action: "row.create", pageId: seed.databaseId, cells: { title: `Neu ${pick(WORDS)} ${Date.now()}`, status: "Offen", priority: "Mittel" } },
      });
    case "page.create":
      return request(name, "/api/command", {
        method: "POST",
        cookie,
        body: { action: "page.create", workspaceId: seed.workspaceId, spaceId: pick(seed.spaceIds), title: `Lasttest ${pick(WORDS)} ${Date.now()}`, kind: "document" },
      });
    case "comment.create":
      return request(name, "/api/command", {
        method: "POST",
        cookie,
        body: { action: "comment.create", pageId: pick(seed.docIds), body: `Kommentar ${pick(WORDS)} ${Date.now()}` },
      });
  }
}

async function readerLoop(vu) {
  // Spread the start so a new step does not begin with a burst.
  await sleep(Math.random() * options.rampMs);
  while (vu.alive) {
    await action(vu, pickAction());
    await sleep(options.think * (0.5 + Math.random()));
  }
}

// --- Editors (real-time collaboration) ---------------------------------------
const sentAt = new Map(); // update (base64) → time it was sent, for fan-out latency
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

async function liveChannel(vu, state) {
  while (vu.alive) {
    const controller = new AbortController();
    vu.abortLive = () => controller.abort();
    try {
      const params = new URLSearchParams({ page: state.pageId, generation: state.generation, client: state.clientId });
      const response = await fetch(`${origin}/api/documents/live?${params}`, {
        headers: { origin, cookie: vu.user.cookie, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok) {
        record("sse.connect", 0, classify(response.status));
        await sleep(2000);
        continue;
      }
      record("sse.connect", 0);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!event.startsWith("data: ")) continue;
          let message;
          try {
            message = JSON.parse(event.slice(6));
          } catch {
            continue;
          }
          state.onLive?.(message);
          if (message.type === "update" && message.update) {
            const at = sentAt.get(message.update);
            if (at !== undefined) record("fanout", performance.now() - at);
            else record("fanout.unmatched", 0);
            Y.applyUpdate(state.doc, Buffer.from(message.update, "base64"), "remote");
          }
        }
      }
      if (vu.alive) record("sse.connect", 0, "closed");
    } catch (e) {
      if (!vu.alive) return;
      record("sse.connect", 0, "network");
      await sleep(1000);
    }
  }
}

async function editorLoop(vu) {
  await sleep(Math.random() * options.rampMs);
  const opened = await request("editor.open", `/api/pages/${vu.docId}`, { cookie: vu.user.cookie, json: true, headers: { "x-flowplan-visit": "1" } });
  if (!opened.ok || !opened.data?.generation) return;
  const doc = new Y.Doc();
  if (opened.data.state) Y.applyUpdate(doc, Buffer.from(opened.data.state, "base64"), "remote");
  const state = { doc, pageId: vu.docId, generation: opened.data.generation, clientId: randomUUID() };
  const pending = [];
  doc.on("update", (update, origin) => {
    if (origin !== "remote") pending.push(update);
  });
  void liveChannel(vu, state);

  let inflight = false,
    timer = null,
    presenceBusy = false,
    presenceAt = 0,
    sequence = 0;
  const sync = async () => {
    timer = null;
    if (inflight || !pending.length) return;
    inflight = true;
    const sent = pending.length;
    const update = b64(Y.mergeUpdates(pending.slice(0, sent)));
    sentAt.set(update, performance.now());
    const result = await request("doc.sync", "/api/command", {
      method: "POST",
      cookie: vu.user.cookie,
      json: true,
      body: { action: "document.sync", pageId: state.pageId, generation: state.generation, update, vector: b64(Y.encodeStateVector(doc)), client: state.clientId },
    });
    setTimeout(() => sentAt.delete(update), 30_000);
    if (result.ok) {
      pending.splice(0, sent);
      if (result.data?.state) Y.applyUpdate(doc, Buffer.from(result.data.state, "base64"), "remote");
    }
    inflight = false;
    if (pending.length && vu.alive) timer = setTimeout(sync, 80);
  };
  let cursorText = null;
  const cursorBody = () => {
    const pos = cursorText ? Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(cursorText, cursorText.length)) : null;
    return { clientId: state.clientId, pageId: state.pageId, generation: state.generation, sequence: ++sequence, cursor: pos && { anchor: pos, head: pos } };
  };
  // --presence on: one request per keystroke (at most every 80 ms).
  const presence = async (text) => {
    cursorText = text;
    if (presenceBusy || performance.now() - presenceAt < 80) return;
    presenceBusy = true;
    presenceAt = performance.now();
    await request("presence", "/api/presence", { method: "POST", cookie: vu.user.cookie, body: cursorBody() });
    presenceBusy = false;
  };
  // --presence poll|push: the web editor's scheduling
  // (lib/collaboration-cursors.ts), with the live channel open.
  const cursors = options.presenceMode === "poll" || options.presenceMode === "push" ? editorCursors(vu, state, cursorBody) : null;
  const moved = (text) => {
    cursorText = text;
    if (cursors) cursors.changed();
    else if (options.presence) void presence(text);
  };

  // Human typing: bursts of 10–40 characters at ~5 per second, a pause of
  // 2–6 s in between; a new paragraph every ~80 characters.
  const fragment = doc.getXmlFragment("default");
  let paragraph = null,
    typed = 0;
  while (vu.alive) {
    const burst = 10 + Math.floor(Math.random() * 30);
    for (let i = 0; i < burst && vu.alive; i++) {
      if (!paragraph || typed % 80 === 79) {
        paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText("")]);
        fragment.insert(fragment.length, [paragraph]);
      }
      const text = paragraph.get(0);
      text.insert(text.length, i === 0 ? " " : String.fromCharCode(97 + Math.floor(Math.random() * 26)));
      typed++;
      if (!timer && !inflight) timer = setTimeout(sync, 80);
      moved(text);
      await sleep(options.keystrokeMs * (0.6 + Math.random() * 0.8));
    }
    await sleep(2000 + Math.random() * 4000);
  }
  clearTimeout(timer);
  cursors?.stop();
  doc.destroy();
}

// The cursors of the web editor (lib/collaboration-cursors.ts, the live
// channel open): a move goes out 40 ms later, at most every 80 ms, one
// request in flight. poll (v0.11): every move; with others every second;
// every "presence" signal asks. push (#383 wave 4): moves only while
// someone else is there (the channel's "audience" signal, or their cursor
// shown); the others' cursors come with the channel ("cursor"), a new one
// gets this cursor at once; with others a heartbeat every 5 s. Alone both
// send a heartbeat every 20 s.
function editorCursors(vu, state, body) {
  const push = options.presenceMode === "push";
  const peers = new Map(); // id → deadline
  let audience = true,
    busy = false,
    pending = false,
    timer = null,
    scheduledAt = Infinity,
    nextSend = 0,
    stopped = false;
  const others = () => {
    const now = performance.now();
    for (const [id, deadline] of peers) if (deadline <= now) peers.delete(id);
    return peers.size > 0;
  };
  const wanted = () => !push || audience || others();
  const idle = () => (others() ? (push ? 5000 : 1000) : 20000);
  function schedule(delay = 40) {
    if (stopped || !vu.alive) return;
    if (busy) {
      pending = true;
      return;
    }
    const wait = Math.max(delay, nextSend - performance.now());
    if (scheduledAt <= performance.now() + wait) return;
    clearTimeout(timer);
    scheduledAt = performance.now() + wait;
    timer = setTimeout(send, wait);
  }
  async function send() {
    scheduledAt = Infinity;
    if (busy || stopped || !vu.alive) return;
    busy = true;
    pending = false;
    nextSend = performance.now() + 80;
    const result = await request("presence", "/api/presence", { method: "POST", cookie: vu.user.cookie, json: true, body: body() });
    if (result.ok && Array.isArray(result.data?.peers)) {
      peers.clear();
      for (const p of result.data.peers) peers.set(p.id, performance.now() + Math.min(15000, p.expiresInMs));
    }
    busy = false;
    schedule(pending ? 40 : result.ok ? idle() : 3000);
  }
  state.onLive = (message) => {
    if (message.type === "presence") schedule(0);
    else if (push && message.type === "audience") {
      audience = message.others !== false;
      if (audience) schedule(0);
    } else if (push && message.type === "cursor" && message.peer) {
      const known = peers.has(message.peer.id);
      if (message.peer.cursor) peers.set(message.peer.id, performance.now() + Math.min(15000, message.peer.expiresInMs));
      else peers.delete(message.peer.id);
      if (!known && message.peer.cursor) schedule(0);
    }
  };
  schedule(0);
  return {
    changed: () => wanted() && schedule(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

// --- Whiteboards (live cursors) -------------------------------------------
// components/whiteboard/whiteboard.tsx: the pointer goes out at most every
// 66 ms; with --presence push only while the stream says someone else has
// the board open, and as it then is when someone arrives.
async function boardLoop(vu) {
  await sleep(Math.random() * options.rampMs);
  const push = options.presenceMode === "push";
  let audience = true,
    latest,
    shown = false,
    queued,
    timer = null,
    lastSent = 0;
  const path = `/api/whiteboards/${vu.boardId}/cursor`;
  const flush = () => {
    timer = null;
    if (queued === undefined) return;
    const point = queued;
    queued = undefined;
    lastSent = performance.now();
    shown = point !== null;
    void request("board.cursor", path, { method: "POST", cookie: vu.user.cookie, body: point });
  };
  const queue = (point) => {
    latest = point;
    if (push && !audience) return;
    queued = point;
    if (timer) return;
    timer = setTimeout(flush, point === null ? 0 : Math.max(0, 66 - (performance.now() - lastSent)));
  };
  void (async () => {
    while (vu.alive) {
      const controller = new AbortController();
      vu.abortLive = () => controller.abort();
      try {
        const response = await fetch(`${origin}/api/whiteboards/${vu.boardId}/cursors`, { headers: { origin, cookie: vu.user.cookie, accept: "text/event-stream" }, signal: controller.signal });
        if (!response.ok) {
          record("sse.connect", 0, classify(response.status));
          await sleep(2000);
          continue;
        }
        record("sse.connect", 0);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!event.startsWith("data: ")) continue;
            let message;
            try {
              message = JSON.parse(event.slice(6));
            } catch {
              continue;
            }
            if (message.type === "cursor") record("board.received", 0);
            else if (message.type === "audience") {
              const before = audience;
              audience = message.others !== false;
              if (push && audience && !before && latest !== undefined && (latest || shown)) queue(latest);
            }
          }
        }
        if (vu.alive) record("sse.connect", 0, "closed");
      } catch {
        if (!vu.alive) return;
        record("sse.connect", 0, "network");
        await sleep(1000);
      }
    }
  })();
  // Bursts of 2–8 s of moving (a pointer event every 33 ms), then 3–10 s
  // still; now and then the pointer leaves the board.
  let x = Math.random() * 1000,
    y = Math.random() * 800;
  while (vu.alive) {
    const until = performance.now() + 2000 + Math.random() * 6000;
    while (vu.alive && performance.now() < until) {
      x += (Math.random() - 0.5) * 30;
      y += (Math.random() - 0.5) * 30;
      queue({ x: Math.round(x), y: Math.round(y) });
      await sleep(33);
    }
    if (Math.random() < 0.3) queue(null);
    await sleep(3000 + Math.random() * 7000);
  }
  clearTimeout(timer);
}

// --- Idle tabs ---------------------------------------------------------------
// A conditional GET like the web app's apiIfChanged: the ETag of the last
// answer goes along; a 304 counts under `<name>.304`.
async function conditional(vu, name, path) {
  const tag = vu.tags.get(path);
  const result = await request(name, path, { cookie: vu.user.cookie, headers: tag ? { "if-none-match": tag } : {}, etag: true });
  if (result.etag) vu.tags.set(path, result.etag);
  return result;
}
async function idleLoop(vu) {
  vu.tags = new Map();
  const push = options.idleMode === "push";
  const interval = push ? 60_000 : options.idleMs;
  // Spread over the whole interval: tabs do not refresh in step.
  await sleep(Math.random() * (push ? options.idleMs : interval));
  const pageId = options.idleDbEvery > 0 && vu.id % options.idleDbEvery === 0 ? seed.databaseId : pick(seed.docIds);
  const bootPath = `/api/bootstrap?workspace=${seed.workspaceId}`,
    pagePath = `/api/pages/${pageId}`;
  if (push) void workspaceSignals(vu, pageId, bootPath, pagePath);
  // Push: the page every 30 s (presence), the bootstrap every second time.
  for (let round = 0; vu.alive; round++) {
    if (!push || round % 2 === 0) await conditional(vu, "idle.bootstrap", bootPath);
    await conditional(vu, "idle.page", pagePath);
    await sleep(push ? interval / 2 : interval);
  }
}
// The workspace's live signal of an idle tab: what a signal names is
// fetched (counted as idle.signal.*), like components/use-workspace-signals.ts.
async function workspaceSignals(vu, pageId, bootPath, pagePath) {
  while (vu.alive) {
    const controller = new AbortController();
    vu.abortLive = () => controller.abort();
    try {
      const response = await fetch(`${origin}/api/live?workspace=${seed.workspaceId}`, {
        headers: { origin, cookie: vu.user.cookie, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok) {
        record("sse.connect", 0, classify(response.status));
        await sleep(2000);
        continue;
      }
      record("sse.connect", 0);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!event.startsWith("data: ")) continue;
          let message;
          try {
            message = JSON.parse(event.slice(6));
          } catch {
            continue;
          }
          if (message.type !== "changed") continue;
          record("signal", 0);
          if (message.parts.includes("tree") || message.parts.includes("notifications")) await conditional(vu, "idle.signal.bootstrap", bootPath);
          if (message.parts.includes("pages") && message.pages?.includes(pageId)) await conditional(vu, "idle.signal.page", pagePath);
        }
      }
      if (vu.alive) record("sse.connect", 0, "closed");
    } catch {
      if (!vu.alive) return;
      record("sse.connect", 0, "network");
      await sleep(1000);
    }
  }
}

// --- Service times ----------------------------------------------------------
// Each request type alone, one after the other on an otherwise idle server:
// the time the server needs for it (its cost), without queueing.
async function probe(count) {
  samples = new Map();
  const vu = { user: seed.users[0], alive: true };
  for (const [name] of MIX) for (let i = 0; i < count; i++) await action(vu, name);
  // What an unchanged refresh costs (an idle tab): the same GET again with
  // the ETag of the answer, answered 304.
  vu.tags = new Map();
  for (const [name, path] of [["bootstrap", `/api/bootstrap?workspace=${seed.workspaceId}`], ["page.open", `/api/pages/${seed.docIds[0]}`], ["db.open", `/api/pages/${seed.databaseId}`]]) {
    await conditional(vu, name, path);
    for (let i = 0; i < count; i++) await conditional(vu, name, path);
  }
  // A keystroke saved on its own (document.sync) in a mid-sized document.
  const opened = await request("editor.open", `/api/pages/${seed.docIds[1]}`, { cookie: vu.user.cookie, json: true });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(opened.data.state, "base64"), "remote");
  const text = doc.getXmlFragment("default").get(1).get(0);
  for (let i = 0; i < count; i++) {
    const before = Y.encodeStateVector(doc);
    text.insert(0, "x");
    await request("doc.sync", "/api/command", {
      method: "POST",
      cookie: vu.user.cookie,
      json: true,
      body: { action: "document.sync", pageId: seed.docIds[1], generation: opened.data.generation, update: b64(Y.encodeStateAsUpdate(doc, before)), vector: b64(Y.encodeStateVector(doc)), client: randomUUID() },
    });
  }
  const out = {};
  for (const [name, b] of samples) out[name] = b;
  samples = new Map();
  parentPort.postMessage({ type: "probe", samples: out });
}

// --- Control ---------------------------------------------------------------
const vus = [];
function setVUs(list) {
  // list: [{ id, kind, docId? }] for this worker
  const wanted = new Map(list.map((v) => [v.id, v]));
  for (const vu of vus) if (!wanted.has(vu.id) && vu.alive) {
    vu.alive = false;
    vu.abortLive?.();
  }
  const running = new Set(vus.filter((v) => v.alive).map((v) => v.id));
  for (const v of list)
    if (!running.has(v.id)) {
      const vu = { ...v, user: seed.users[v.userIndex], alive: true };
      vus.push(vu);
      void (v.kind === "editor" ? editorLoop(vu) : v.kind === "idle" ? idleLoop(vu) : v.kind === "board" ? boardLoop(vu) : readerLoop(vu));
    }
}
parentPort.on("message", (msg) => {
  if (msg.type === "vus") setVUs(msg.list);
  else if (msg.type === "flush") {
    const out = {};
    for (const [name, b] of samples) out[name] = b;
    samples = new Map();
    const lag = { p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 };
    loop.reset();
    parentPort.postMessage({ type: "samples", samples: out, lag, reads: [...READS] });
  } else if (msg.type === "probe") void probe(msg.count);
  else if (msg.type === "stop") {
    for (const vu of vus) {
      vu.alive = false;
      vu.abortLive?.();
    }
    setTimeout(() => process.exit(0), 200);
  }
});
parentPort.postMessage({ type: "ready" });
