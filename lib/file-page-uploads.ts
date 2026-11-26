// Files uploaded straight into a space from the web app (#569): a file
// dropped on the sidebar's tree, "Datei hochladen …" in "Neue Seite" and
// in a space's menu, the media view's upload. Each file becomes a page of
// its own (POST /api/upload, purpose "page", lib/file-pages.ts). The files
// go up one after the other, in the order they were chosen, each with its
// progress and a cancel button (as in documents, #561); a refused file
// does not stop the next. Kept apart from React (components/
// file-page-uploads.tsx shows it) so the tests can drive it.
import { isCancelled, sendWithProgress, type Progress } from "./upload-progress";

export type FilePagePlace = { spaceId: string; parentId: string | null };
export type CreatedFilePage = { id: string; title: string; spaceId: string; parentId: string | null };
export type FilePageUpload = {
  key: number;
  name: string;
  size: number;
  loaded: number;
  state: "waiting" | "uploading" | "done" | "failed" | "cancelled";
  error?: string;
  page?: CreatedFilePage;
  place: FilePagePlace;
};

type Answer = { page?: CreatedFilePage };
export type Sender = (form: FormData, options: { size: number; onProgress: (progress: Progress) => void }) => { done: Promise<Answer>; cancel(): void };

// The form of one file: where the page goes before the file, so a place
// that refuses does so before the file is sent.
export function filePageForm(file: File, place: FilePagePlace) {
  const form = new FormData();
  form.set("purpose", "page");
  form.set("spaceId", place.spaceId);
  if (place.parentId) form.set("parentId", place.parentId);
  form.set("file", file);
  return form;
}

export function filePageUploads(options: {
  send: Sender;
  // Photos shrink before upload, as in documents (lib/image-compress.ts).
  prepare?: (file: File) => Promise<File>;
  onChange: (items: FilePageUpload[]) => void;
  onCreated?: (page: CreatedFilePage, item: FilePageUpload) => void;
  // All files of the queue are through (made, refused or cancelled).
  onIdle?: (items: FilePageUpload[]) => void;
}) {
  let items: FilePageUpload[] = [];
  let serial = 0;
  let running = false;
  let current: { key: number; cancel(): void } | null = null;
  const files = new Map<number, File>();
  const changed = () => options.onChange(items.map((item) => ({ ...item })));
  const patch = (key: number, change: Partial<FilePageUpload>) => {
    items = items.map((item) => (item.key === key ? { ...item, ...change } : item));
    changed();
  };
  async function run() {
    if (running) return;
    running = true;
    try {
      for (let next = items.find((i) => i.state === "waiting"); next; next = items.find((i) => i.state === "waiting")) {
        const key = next.key;
        const original = files.get(key)!;
        files.delete(key);
        patch(key, { state: "uploading", loaded: 0 });
        try {
          const file = options.prepare ? await options.prepare(original) : original;
          if (items.find((i) => i.key === key)?.state !== "uploading") continue;
          const request = options.send(filePageForm(file, next.place), {
            size: file.size,
            onProgress: ({ loaded, total }) => patch(key, { loaded, size: total }),
          });
          current = { key, cancel: request.cancel };
          const answer = await request.done;
          const done = { state: "done" as const, loaded: file.size, size: file.size, page: answer.page };
          patch(key, done);
          if (answer.page) options.onCreated?.(answer.page, items.find((i) => i.key === key)!);
        } catch (error) {
          if (isCancelled(error) || items.find((i) => i.key === key)?.state === "cancelled") patch(key, { state: "cancelled" });
          else patch(key, { state: "failed", error: (error as Error).message });
        } finally {
          current = null;
        }
      }
    } finally {
      running = false;
    }
    options.onIdle?.(items.map((item) => ({ ...item })));
  }
  const cancel = (key: number) => {
    const item = items.find((i) => i.key === key);
    if (!item || (item.state !== "waiting" && item.state !== "uploading")) return;
    files.delete(key);
    patch(key, { state: "cancelled" });
    if (current?.key === key) current.cancel();
  };
  return {
    add(chosen: File[], place: FilePagePlace) {
      for (const file of chosen) {
        const key = ++serial;
        files.set(key, file);
        items = [...items, { key, name: file.name, size: file.size, loaded: 0, state: "waiting", place }];
      }
      changed();
      void run();
    },
    cancel,
    cancelAll() {
      for (const item of items) if (item.state === "waiting" || item.state === "uploading") cancel(item.key);
    },
    // Finished entries leave the list (the panel's close button).
    clear() {
      items = items.filter((i) => i.state === "waiting" || i.state === "uploading");
      changed();
    },
    get busy() {
      return items.some((i) => i.state === "waiting" || i.state === "uploading");
    },
  };
}
export type FilePageUploader = ReturnType<typeof filePageUploads>;

// The real sender: POST /api/upload with the upload's progress.
export const sendFilePage =
  (headers: () => Record<string, string>, onStatus?: (status: number) => void): Sender =>
  (form, { size, onProgress }) =>
    sendWithProgress<Answer>("/api/upload", form, { headers: headers(), size, onProgress, onStatus });

// Files of a drag from the computer (not pages or text dragged in the app).
export const carriesFiles = (types: readonly string[] | DOMStringList) => Array.from(types as ArrayLike<string>).includes("Files");
