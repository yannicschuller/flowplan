import { test } from "node:test";
import assert from "node:assert/strict";
import { isCancelled, sendWithProgress, UploadCancelled } from "../lib/upload-progress";

// The upload with progress (#561, lib/upload-progress.ts) against a fake
// XMLHttpRequest: the request as fetch() sent it (POST, the form, the
// Idempotency-Key), progress reports, the answer read like fetch()'s
// callers read it, a cancel that is no error.
type Sent = { method: string; url: string; headers: Record<string, string>; body: unknown };
function fakeRequest() {
  const made: FakeRequest[] = [];
  class FakeRequest {
    sent: Sent = { method: "", url: "", headers: {}, body: null };
    status = 0;
    responseText = "";
    upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() {
      made.push(this);
    }
    open(method: string, url: string) {
      Object.assign(this.sent, { method, url });
    }
    setRequestHeader(name: string, value: string) {
      this.sent.headers[name] = value;
    }
    send(body: unknown) {
      this.sent.body = body;
    }
    abort() {
      this.onabort?.();
    }
    answer(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.onload?.();
    }
  }
  return { Request: FakeRequest as unknown as typeof XMLHttpRequest, made };
}

test("sends the form with its headers and reports the progress", async () => {
  const { Request, made } = fakeRequest();
  const form = new FormData();
  form.set("pageId", "p1");
  const seen: { loaded: number; total: number }[] = [];
  const statuses: number[] = [];
  const upload = sendWithProgress<{ url: string }>("/api/upload", form, {
    headers: { "Idempotency-Key": "key-12345678" },
    size: 1000,
    onProgress: (p) => seen.push(p),
    onStatus: (s) => statuses.push(s),
    Request,
  });
  const request = made[0] as unknown as { sent: Sent; upload: { onprogress: (e: object) => void }; answer: (s: number, t: string) => void };
  assert.deepEqual(request.sent, { method: "POST", url: "/api/upload", headers: { "Idempotency-Key": "key-12345678" }, body: form });
  request.upload.onprogress({ loaded: 400, total: 1200, lengthComputable: true });
  // Without a known total: the file's size.
  request.upload.onprogress({ loaded: 600, total: 0, lengthComputable: false });
  request.answer(200, JSON.stringify({ url: "/api/files/abc" }));
  assert.deepEqual(await upload.done, { url: "/api/files/abc" });
  assert.deepEqual(seen, [
    { loaded: 400, total: 1200 },
    { loaded: 600, total: 1000 },
  ]);
  assert.deepEqual(statuses, [200]);
});

test("a refusal carries the server's message, no connection fetch()'s TypeError", async () => {
  const { Request, made } = fakeRequest();
  const refused = sendWithProgress("/api/upload", new FormData(), { Request });
  (made[0] as unknown as { answer: (s: number, t: string) => void }).answer(413, JSON.stringify({ error: "Die Datei ist größer als 20 MB." }));
  await assert.rejects(refused.done, (e: Error) => e.message === "Die Datei ist größer als 20 MB." && !isCancelled(e));

  const offline = sendWithProgress("/api/upload", new FormData(), { Request });
  (made[1] as unknown as { onerror: () => void }).onerror();
  await assert.rejects(offline.done, (e: Error) => e instanceof TypeError && e.message === "Failed to fetch");

  // Not JSON (a proxy's error page): as r.json() would fail.
  const html = sendWithProgress("/api/upload", new FormData(), { Request });
  (made[2] as unknown as { answer: (s: number, t: string) => void }).answer(502, "<html>Bad Gateway</html>");
  await assert.rejects(html.done, SyntaxError);
});

test("cancel aborts the request and is told apart from errors", async () => {
  const { Request, made } = fakeRequest();
  let aborted = 0;
  const upload = sendWithProgress("/api/upload", new FormData(), { Request });
  const request = made[0] as unknown as { abort: () => void };
  const abort = request.abort.bind(request);
  request.abort = () => {
    aborted++;
    abort();
  };
  upload.cancel();
  await assert.rejects(upload.done, (e) => e instanceof UploadCancelled && isCancelled(e));
  assert.equal(aborted, 1);
});
