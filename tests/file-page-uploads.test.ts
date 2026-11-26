// The web app's queue of files uploaded as pages (#569,
// lib/file-page-uploads.ts): one after the other in the chosen order, the
// place before the file in each form, progress per file, a cancel that
// stops only its file, a refusal that does not stop the next.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UploadCancelled } from "../lib/upload-progress";
import { carriesFiles, filePageForm, filePageUploads, type FilePageUpload, type Sender } from "../lib/file-page-uploads";

const space = "11111111-1111-4111-8111-111111111111",
  parent = "22222222-2222-4222-8222-222222222222";
const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: "application/octet-stream" });

// A sender whose requests the test answers one by one.
function fakeSender() {
  const calls: { form: FormData; progress: (loaded: number, total: number) => void; answer: (page?: string) => void; refuse: (message: string) => void; cancelled: boolean }[] = [];
  const send: Sender = (form, { onProgress }) => {
    let resolve!: (value: { page?: { id: string; title: string; spaceId: string; parentId: string | null } }) => void, reject!: (error: Error) => void;
    const done = new Promise<{ page?: { id: string; title: string; spaceId: string; parentId: string | null } }>((ok, fail) => ((resolve = ok), (reject = fail)));
    const call = {
      form,
      cancelled: false,
      progress: (loaded: number, total: number) => onProgress({ loaded, total }),
      answer: (page = "p") => resolve({ page: { id: page, title: String((form.get("file") as File).name), spaceId: String(form.get("spaceId")), parentId: (form.get("parentId") as string) || null } }),
      refuse: (message: string) => reject(new Error(message)),
    };
    calls.push(call);
    return {
      done,
      cancel() {
        call.cancelled = true;
        reject(new UploadCancelled());
      },
    };
  };
  return { send, calls };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the form names the place before the file", () => {
  const form = filePageForm(file("a.pdf"), { spaceId: space, parentId: parent });
  assert.deepEqual([...form.keys()], ["purpose", "spaceId", "parentId", "file"]);
  assert.equal(form.get("purpose"), "page");
  assert.deepEqual([...filePageForm(file("a.pdf"), { spaceId: space, parentId: null }).keys()], ["purpose", "spaceId", "file"]);
  assert.equal(carriesFiles(["Files"]), true);
  assert.equal(carriesFiles(["application/x-flowplan-page", "text/html"]), false);
});

test("files go up one after the other, with progress; a refusal does not stop the next", async () => {
  const { send, calls } = fakeSender();
  let items: FilePageUpload[] = [];
  const created: string[] = [];
  let idle = 0;
  const queue = filePageUploads({ send, onChange: (next) => (items = next), onCreated: (page) => created.push(page.id), onIdle: () => idle++ });
  queue.add([file("one.png"), file("two.pdf"), file("three.docx")], { spaceId: space, parentId: null });
  await tick();
  assert.equal(calls.length, 1, "only the first is sent");
  assert.deepEqual(items.map((i) => i.state), ["uploading", "waiting", "waiting"]);
  assert.equal(queue.busy, true);
  calls[0].progress(5, 10);
  assert.equal(items[0].loaded, 5);
  calls[0].answer("page-1");
  await tick();
  await tick();
  assert.deepEqual(created, ["page-1"]);
  assert.equal(calls.length, 2);
  calls[1].refuse("Too large.");
  await tick();
  await tick();
  assert.equal(items[1].state, "failed");
  assert.equal(items[1].error, "Too large.");
  calls[2].answer("page-3");
  await tick();
  await tick();
  assert.deepEqual(items.map((i) => i.state), ["done", "failed", "done"]);
  assert.equal(items[2].page?.id, "page-3");
  assert.equal(idle, 1);
  assert.equal(queue.busy, false);
  queue.clear();
  assert.deepEqual(items, []);
});

test("cancel stops its own file only; cancelling all leaves nothing waiting", async () => {
  const { send, calls } = fakeSender();
  let items: FilePageUpload[] = [];
  const queue = filePageUploads({ send, onChange: (next) => (items = next) });
  queue.add([file("a.png"), file("b.png"), file("c.png")], { spaceId: space, parentId: parent });
  await tick();
  // The waiting second one is taken out before it goes.
  queue.cancel(items[1].key);
  queue.cancel(items[0].key);
  assert.equal(calls[0].cancelled, true);
  await tick();
  await tick();
  assert.equal(calls.length, 2, "the third one goes next");
  assert.equal((calls[1].form.get("file") as File).name, "c.png");
  assert.equal(calls[1].form.get("parentId"), parent);
  assert.deepEqual(items.map((i) => i.state), ["cancelled", "cancelled", "uploading"]);
  queue.add([file("d.png")], { spaceId: space, parentId: null });
  queue.cancelAll();
  await tick();
  await tick();
  assert.deepEqual(items.map((i) => i.state), ["cancelled", "cancelled", "cancelled", "cancelled"]);
  assert.equal(calls.length, 2);
});
