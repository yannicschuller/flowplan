// A large synthetic AFFiNE workspace imported the way the import page does
// it (#163): as a background job (lib/background-jobs.ts launchJob) that
// the page asks for its outcome, from the upload on disk – then the pages
// deleted (into the trash) and the same file imported again. Run by
// tests/affine-large-import.test.ts in a process with a small heap: before
// #163 every page's DOM stayed in memory until the import's transaction
// ended, and the process ran out of memory. The file is built by the test
// (largeAffine below); prints one JSON line.
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Identity } from "../../lib/types";
import { affineFileV2, note, page, para, PNG } from "./affine-fixture";

// N documents with many paragraphs, a picture each and every tenth with a
// picture on its whiteboard.
export function largeAffine(path: string, pages: number, paragraphs: number, blobBytes: number) {
  const lorem = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
  const docs = [];
  const blobs = [];
  for (let i = 0; i < pages; i++) {
    const key = `blob${i}`;
    blobs.push({ key, data: Buffer.concat([PNG, Buffer.alloc(blobBytes, i % 251)]), mime: "image/png" });
    const text = Array.from({ length: paragraphs }, (_, j) => para(`${j} ${lorem}${lorem}`));
    const picture = { id: `img${i}`, flavour: "affine:image", props: { sourceId: key, caption: `Bild ${i}` } };
    const surface = i % 10 ? undefined : { children: [{ id: `board-img${i}`, flavour: "affine:image", props: { sourceId: key, xywh: "[0,0,100,100]", index: "a1" } }] };
    docs.push({ id: `doc${i}`, title: `Seite ${i}`, doc: page(`doc${i}`, `Seite ${i}`, [note([...text, picture])], surface) });
  }
  writeFileSync(path, affineFileV2({ id: "ws-large", name: "Groß", docs, blobs }));
}
// Run as a script (not imported by the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await importTwice(process.argv[2]);

async function importTwice(file: string) {
  process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-affine-large-"));
  const { all, id, one, run } = await import("../../lib/db");
  const { createWorkspace } = await import("../../lib/seed");
  const { bootstrap, command } = await import("../../lib/api");
  const { importFromSource } = await import("../../lib/importers");
  const { launchJob, jobOutcome } = await import("../../lib/background-jobs");

  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Groß", "gross@example.test");
  const owner = { id: uid, name: "Groß", email: "gross@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  const wid = await createWorkspace(uid, "Groß");
  const space = (await bootstrap(owner, wid)).spaces[0].id;

  // As the route with background=1 and GET /api/import/source/job.
  async function inBackground<T>(work: () => Promise<T>): Promise<T> {
    const job = await launchJob(owner, "import", "large.affine", work);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const outcome = (await jobOutcome(owner, job))!;
      if (outcome.status === "done") return outcome.value as T;
      if (outcome.status === "failed") throw outcome.error;
    }
  }
  const upload = () => {
    const path = join(process.env.FLOWPLAN_DATA_DIR!, `upload-${id()}`);
    copyFileSync(file, path);
    return { name: "large.affine", path };
  };
  const livePages = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND kind<>'journal'", wid))!.n);
  const files = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM files f JOIN pages p ON p.id=f.page_id WHERE p.workspace_id=?", wid))!.n);
  const before = await livePages();

  const preview = await inBackground(() => importFromSource(owner, wid, space, upload(), { dryRun: true }));
  const first = await inBackground(() => importFromSource(owner, wid, space, upload()));
  // Pages and files in the workspace (the result counts them as the preview).
  const afterFirst = { pages: (await livePages()) - before, files: await files() };
  // Deleted as a person deletes them: into the trash, with everything below.
  for (const rootId of first.rootIds) await command(owner, { action: "page.delete", pageId: rootId });
  const trashed = (await livePages()) - before;
  const second = await inBackground(() => importFromSource(owner, wid, space, upload()));
  const afterSecond = { pages: (await livePages()) - before, files: await files() };
  const titles = (await all<{ title: string }>("SELECT title FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND title LIKE 'Seite %'", wid)).length;

  console.log(
    JSON.stringify({
      preview: { pages: preview.pages, files: preview.files, whiteboards: preview.whiteboards },
      first: { ...afterFirst, roots: first.rootIds.length },
      trashed,
      second: { ...afterSecond, roots: second.rootIds.length },
      titles,
    }),
  );
}
