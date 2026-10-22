"use client";
// The editor of a page in an end-to-end encrypted space (docs/e2ee-design.md).
// It syncs on its own path: every local Yjs update is encrypted with the
// space key before it leaves the browser and appended to the page's log;
// updates of others arrive as ciphertext (live channel or poll) and are
// decrypted here. From time to time the browser stores the encrypted full
// state as a snapshot so the log stays short. Nothing is cached on the
// device: no IndexedDB copy, no HTML to the server, no AI, no comments.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import Highlight from "@tiptap/extension-highlight";
import Collaboration from "@tiptap/extension-collaboration";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Node, mergeAttributes } from "@tiptap/core";
import * as Y from "yjs";
import {
  CheckSquare,
  Code,
  DownloadSimple,
  FileArrowUp,
  ListBullets,
  ListNumbers,
  LockKey,
  Quotes,
  TextB,
  TextHOne,
  TextHTwo,
  TextItalic,
} from "@phosphor-icons/react";
import { api, download } from "./ui";
import { useT } from "./i18n";
import * as e2ee from "@/lib/e2ee";
import { documentMarkdown, type JsonNode } from "@/lib/e2ee-markdown";
import { exportName } from "@/lib/export-name";
import type { SaveStatus } from "@/lib/save-status";
import { beforeLock, openSpace, spaceKey } from "./e2ee-store";

type LogEntry = { seq: number; version: number; data: string };
type Log = { keyVersion: number; snapshot: { upto: number; version: number; data: string } | null; updates: LogEntry[]; more: boolean; pending: number };
// Compact once this many updates pile up behind the snapshot.
const COMPACT_AFTER = 200;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// A file of the page: stored encrypted, opened in the browser. Images show
// inline; other files download decrypted.
function encryptedFileNode(keys: () => { spaceId: string; pageId: string }) {
  return Node.create({
    name: "encryptedFile",
    group: "block",
    atom: true,
    draggable: true,
    addAttributes() {
      return { fileId: { default: null }, name: { default: "" }, mime: { default: "" }, size: { default: 0 } };
    },
    parseHTML() {
      return [{ tag: "div[data-encrypted-file]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["div", mergeAttributes(HTMLAttributes, { "data-encrypted-file": "" })];
    },
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement("div");
        dom.className = "e2ee-file";
        dom.contentEditable = "false";
        const { spaceId, pageId } = keys();
        const name = String(node.attrs.name || "");
        const mime = String(node.attrs.mime || "");
        let url = "";
        const fetchPlain = async () => {
          const response = await fetch(`/api/files/${node.attrs.fileId}`, { cache: "no-store" });
          if (!response.ok) throw new Error(String(response.status));
          const file = await e2ee.decryptFile((v) => spaceKey(spaceId, v), pageId, new Uint8Array(await response.arrayBuffer()));
          return new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime || "application/octet-stream" });
        };
        if (mime.startsWith("image/")) {
          const img = document.createElement("img");
          img.alt = name;
          dom.append(img);
          void fetchPlain()
            .then((blob) => {
              url = URL.createObjectURL(blob);
              img.src = url;
            })
            .catch(() => dom.classList.add("failed"));
        } else {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "e2ee-file-download";
          button.textContent = `🔒 ${name}`;
          button.onclick = () =>
            void fetchPlain().then((blob) => {
              const link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = name || "file";
              link.click();
              setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
            });
          dom.append(button);
        }
        return { dom, destroy: () => url && URL.revokeObjectURL(url) };
      };
    },
  });
}

export default function EncryptedEditor({
  pageId,
  spaceId,
  title,
  editable,
  onStatus,
  onError,
}: {
  pageId: string;
  spaceId: string;
  title: string;
  editable: boolean;
  onStatus: (status: SaveStatus) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  // The callbacks change with every render of the page; the sync keeps
  // the latest without reconnecting.
  const report = useRef({ onStatus, onError });
  report.current = { onStatus, onError };
  const status = useCallback((value: SaveStatus) => report.current.onStatus(value), []);
  const fail = useCallback((message: string) => report.current.onError(message), []);
  const doc = useMemo(() => new Y.Doc(), [pageId]);
  const liveId = useMemo(() => crypto.randomUUID(), [pageId]);
  // `complete`: every update up to this sequence number is applied here.
  const complete = useRef(0),
    pending = useRef<Uint8Array[]>([]),
    sending = useRef(false),
    loading = useRef(false),
    ready = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const context = useRef({ spaceId, pageId });
  context.current = { spaceId, pageId };
  const fileNode = useMemo(() => encryptedFileNode(() => context.current), []);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: [
        StarterKit.configure({ undoRedo: false, link: { openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer" } } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Highlight,
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({ placeholder: t("Schreibe etwas – nur Mitglieder mit Schlüssel können es lesen …", "Write something – only members with the key can read it …") }),
        fileNode,
        Collaboration.configure({ document: doc }),
      ],
      editorProps: { attributes: { class: "document-editor e2ee-editor", "aria-label": t("Verschlüsselter Dokumentinhalt", "Encrypted document content") } },
    },
    [doc, editable],
  );
  useEffect(() => () => doc.destroy(), [doc]);

  const decrypt = useCallback(
    async (purpose: e2ee.Purpose, version: number, data: string) => {
      const key = spaceKey(spaceId, version) || (await openSpace(spaceId, true), spaceKey(spaceId, version));
      if (!key) throw new Error(t("Dir fehlt der Schlüssel für diesen Inhalt.", "You do not have the key for this content."));
      return e2ee.decryptContent(key, e2ee.fromBase64(data), e2ee.contentContext(purpose, pageId, version));
    },
    [spaceId, pageId],
  );

  // The encrypted log since the last complete position.
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      let log: Log;
      do {
        log = await api<Log>(`/api/e2ee/pages/${pageId}/log?after=${complete.current}`);
        if (log.snapshot) {
          Y.applyUpdate(doc, await decrypt("snapshot", log.snapshot.version, log.snapshot.data), "remote");
          complete.current = Math.max(complete.current, log.snapshot.upto);
        }
        for (const entry of log.updates) {
          Y.applyUpdate(doc, await decrypt("update", entry.version, entry.data), "remote");
          complete.current = Math.max(complete.current, entry.seq);
        }
      } while (log.more);
      if (!ready.current) {
        ready.current = true;
        setLoaded(true);
        status("saved");
      }
      // Many updates since the snapshot: store the encrypted full state.
      if (editable && log.pending >= COMPACT_AFTER && !pending.current.length) {
        const key = spaceKey(spaceId);
        if (key)
          await api("/api/command", {
            action: "e2ee.compact",
            pageId,
            upto: complete.current,
            version: key.version,
            data: e2ee.toBase64(await e2ee.encryptContent(key, Y.encodeStateAsUpdate(doc), e2ee.contentContext("snapshot", pageId, key.version))),
          }).catch(() => {});
      }
    } catch (error) {
      fail((error as Error).message);
      status("failed");
    } finally {
      loading.current = false;
    }
  }, [doc, pageId, spaceId, editable, decrypt, status, fail]);

  // Local changes: merged, encrypted, appended.
  const send = useCallback(async () => {
    if (sending.current || !pending.current.length || !ready.current) return;
    sending.current = true;
    const batch = pending.current.splice(0);
    status("saving");
    try {
      let key = spaceKey(spaceId);
      if (!key) throw new Error(t("Bitte zuerst entsperren.", "Please unlock first."));
      const update = Y.mergeUpdates(batch);
      const append = async (k: e2ee.SpaceKey) =>
        api<{ seq: number }>("/api/command", {
          action: "e2ee.append",
          pageId,
          version: k.version,
          client: liveId,
          data: e2ee.toBase64(await e2ee.encryptContent(k, update, e2ee.contentContext("update", pageId, k.version))),
        });
      let result: { seq: number };
      try {
        result = await append(key);
      } catch (error) {
        // A new space key (someone left): fetch or make it, then once more.
        if ((error as { status?: number }).status !== 409) throw error;
        await openSpace(spaceId, true);
        key = spaceKey(spaceId);
        if (!key) throw error;
        result = await append(key);
      }
      if (result.seq === complete.current + 1) complete.current = result.seq;
      status(pending.current.length ? "unsaved" : "saved");
    } catch (error) {
      pending.current.unshift(...batch);
      status(navigator.onLine ? "failed" : "saved-offline");
      fail((error as Error).message);
    } finally {
      sending.current = false;
      if (pending.current.length) timer.current = setTimeout(() => void send(), 2000);
    }
  }, [pageId, spaceId, liveId, status, fail]);

  // Locking (button or auto-lock) waits for unsaved changes to go out.
  useEffect(() => beforeLock(async () => {
    clearTimeout(timer.current);
    await send();
  }), [send]);
  useEffect(() => {
    const listener = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || !editable) return;
      pending.current.push(update);
      status("unsaved");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void send(), 250);
    };
    doc.on("update", listener);
    return () => {
      doc.off("update", listener);
      clearTimeout(timer.current);
      void send();
    };
  }, [doc, editable, send, status]);

  useEffect(() => {
    status("loading");
    void load();
    const poll = setInterval(() => void load(), 20_000);
    let source: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      const params = new URLSearchParams({ page: pageId, generation: "e2ee", client: liveId });
      source = new EventSource(`/api/documents/live?${params}`);
      source.onmessage = (event) => {
        let message: { type: string } & Partial<LogEntry>;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "ready") void load();
        else if (message.type === "revoked") source?.close();
        else if (message.type === "e2ee" && message.data && message.version && message.seq) {
          const { seq, version, data } = message;
          void decrypt("update", version, data)
            .then((update) => {
              Y.applyUpdate(doc, update, "remote");
              if (seq === complete.current + 1) complete.current = seq;
              else void load();
            })
            .catch(() => void load());
        }
      };
    }
    return () => {
      clearInterval(poll);
      source?.close();
    };
  }, [doc, pageId, liveId, load, decrypt, status]);

  async function upload(file: File) {
    const key = spaceKey(spaceId);
    if (!key || !editor) return;
    if (file.size > MAX_FILE_BYTES) return fail(t("Maximal 50 MB pro Datei.", "At most 50 MB per file."));
    setUploading(true);
    try {
      const sealed = await e2ee.encryptFile(key, pageId, { name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      const form = new FormData();
      form.set("pageId", pageId);
      form.set("purpose", "e2ee");
      form.set("file", new Blob([sealed as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }), "encrypted.bin");
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t("Hochladen fehlgeschlagen.", "Upload failed."));
      editor
        .chain()
        .focus()
        .insertContent({ type: "encryptedFile", attrs: { fileId: result.id, name: file.name, mime: file.type, size: file.size } })
        .run();
    } catch (error) {
      fail((error as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            h1: e.isActive("heading", { level: 1 }),
            h2: e.isActive("heading", { level: 2 }),
            bullet: e.isActive("bulletList"),
            ordered: e.isActive("orderedList"),
            task: e.isActive("taskList"),
            quote: e.isActive("blockquote"),
            code: e.isActive("codeBlock"),
          }
        : null,
  });
  const button = (label: string, active: boolean | undefined, run: () => void, icon: React.ReactNode) => (
    <button type="button" className={`icon-button ${active ? "active" : ""}`} title={label} aria-label={label} aria-pressed={!!active} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {icon}
    </button>
  );
  const chain = () => editor!.chain().focus();
  return (
    <div className="e2ee-document">
      <div className="e2ee-toolbar" role="toolbar" aria-label={t("Formatierung", "Formatting")}>
        <span className="e2ee-badge" title={t("Ende-zu-Ende-verschlüsselt: Der Server sieht nur Chiffretext.", "End-to-end encrypted: the server only sees ciphertext.")}>
          <LockKey size={14} weight="fill" />
          {t("Ende-zu-Ende-verschlüsselt", "End-to-end encrypted")}
        </span>
        {editable && editor && state && (
          <>
            {button(t("Fett", "Bold"), state.bold, () => chain().toggleBold().run(), <TextB size={16} />)}
            {button(t("Kursiv", "Italic"), state.italic, () => chain().toggleItalic().run(), <TextItalic size={16} />)}
            {button(t("Überschrift 1", "Heading 1"), state.h1, () => chain().toggleHeading({ level: 1 }).run(), <TextHOne size={16} />)}
            {button(t("Überschrift 2", "Heading 2"), state.h2, () => chain().toggleHeading({ level: 2 }).run(), <TextHTwo size={16} />)}
            {button(t("Aufzählung", "Bulleted list"), state.bullet, () => chain().toggleBulletList().run(), <ListBullets size={16} />)}
            {button(t("Nummerierte Liste", "Numbered list"), state.ordered, () => chain().toggleOrderedList().run(), <ListNumbers size={16} />)}
            {button(t("Aufgabenliste", "Task list"), state.task, () => chain().toggleTaskList().run(), <CheckSquare size={16} />)}
            {button(t("Zitat", "Quote"), state.quote, () => chain().toggleBlockquote().run(), <Quotes size={16} />)}
            {button(t("Codeblock", "Code block"), state.code, () => chain().toggleCodeBlock().run(), <Code size={16} />)}
            {button(
              uploading ? t("Wird verschlüsselt hochgeladen …", "Uploading encrypted …") : t("Datei oder Bild verschlüsselt hinzufügen", "Add an encrypted file or image"),
              false,
              () => uploadRef.current?.click(),
              <FileArrowUp size={16} />,
            )}
            <input
              ref={uploadRef}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }}
            />
          </>
        )}
        <span className="e2ee-toolbar-end">
          <button
            type="button"
            className="text-button"
            disabled={!editor || !loaded}
            title={t("Im Browser entschlüsselt als Markdown speichern", "Save decrypted as Markdown, in the browser")}
            onClick={() => editor && download(`${exportName(title) || "flowplan"}.md`, documentMarkdown(editor.getJSON() as JsonNode, title), "text/markdown")}
          >
            <DownloadSimple size={14} /> {t("Markdown (entschlüsselt)", "Markdown (decrypted)")}
          </button>
          <a className="text-button" href={`/api/e2ee/spaces/${spaceId}/archive`} download>
            <DownloadSimple size={14} /> {t("Verschlüsseltes Archiv", "Encrypted archive")}
          </a>
        </span>
      </div>
      {!loaded && <p className="muted">{t("Wird entschlüsselt …", "Decrypting …")}</p>}
      <EditorContent editor={editor} />
    </div>
  );
}
