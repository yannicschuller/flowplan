"use client";
import { tr } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import dynamic from "next/dynamic";
import { LinkedDatabase } from "@/lib/document-schema";
import type { Page, User, Role } from "@/lib/types";
import type { DatabaseData } from "./database-view";
import { api } from "./ui";
const DatabaseView = dynamic(() => import("./database-view"), {
  ssr: false,
  loading: () => <p>{tr("Ansicht wird geöffnet …", "Opening view …")}</p>,
});
export type LinkedEditorContext = {
  pageId: string;
  // Set when the host is a record document.
  rowId?: string;
  userId: string;
  pages: Page[];
  members: User[];
  generation: string;
  update: () => string;
  receive: (state: string) => void;
};
type LinkedData = DatabaseData & {
  page: Page;
  role: Role;
  hostRole: Role;
  hostLocked: boolean;
  sourceVersion: number;
};
function LinkedDatabaseView({
  node,
  extension,
  deleteNode,
  editor,
}: NodeViewProps) {
  const t = useT();
  const context = () =>
    (extension.options.context as () => LinkedEditorContext)();
  const host = context().pageId,
    hostRow = context().rowId,
    block = String(node.attrs.id);
  const [data, setData] = useState<LinkedData | null>(null),
    [error, setError] = useState("");
  const sequence = useRef(0),
    busy = useRef(false),
    alive = useRef(true);
  async function load() {
    if (busy.current) return;
    const request = ++sequence.current;
    try {
      const next = await api<LinkedData>(
        hostRow
          ? `/api/pages/${host}/rows/${hostRow}/linked/${block}`
          : `/api/pages/${host}/linked/${block}`,
      );
      if (alive.current && request === sequence.current) {
        setData(next);
        setError("");
      }
      return next;
    } catch (error) {
      if (alive.current && request === sequence.current) {
        setData(null);
        setError((error as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(load, 2500);
    window.addEventListener("focus", load);
    return () => {
      alive.current = false;
      sequence.current++;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [host, hostRow, block]);
  async function mutate(mutation: Record<string, unknown>) {
    if (!data) throw new Error(t("Datenquelle wird geladen.", "Loading data source."));
    busy.current = true;
    ++sequence.current;
    setError("");
    try {
      const current = context();
      const response = await api<{
        data: LinkedData;
        state: string;
        result: unknown;
      }>("/api/command", {
        action: "linked.command",
        pageId: host,
        rowId: hostRow,
        blockId: block,
        generation: current.generation,
        update: current.update(),
        sourceVersion: data.sourceVersion,
        mutation,
      });
      current.receive(response.state);
      if (alive.current) setData(response.data);
      return response.result;
    } finally {
      busy.current = false;
    }
  }
  const current = context();
  return (
    <NodeViewWrapper
      className="linked-database"
      data-linked-view={block}
      contentEditable={false}
    >
      <header className="linked-database-header">
        <span>{t("Verknüpfte Datenbank", "Linked database")}</span>
        {data && (
          <a href={`/#page=${data.page.id}`} title={t("Datenquelle öffnen", "Open data source")}>
            {data.page.title} ↗
          </a>
        )}
        {editor.isEditable && (
          <button
            type="button"
            className="text-button"
            onClick={deleteNode}
            title={t("Einbettung entfernen", "Remove embed")}
          >
            {t("Entfernen", "Remove")}
          </button>
        )}
      </header>
      {error && (
        <div className="linked-database-error" role="status">
          {error}
          <button className="button compact" onClick={() => void load()}>
            {t("Erneut laden", "Reload")}
          </button>
        </div>
      )}
      {!data && !error && <p>{t("Einbettung wird gespeichert und geladen …", "Saving and loading embed …")}</p>}
      {data && (
        <div className="linked-database-body">
          <DatabaseView
            data={data}
            page={data.page}
            userId={current.userId}
            members={current.members}
            pages={current.pages}
            editable={data.role !== "viewer" && !data.page.locked}
            viewEditable={data.hostRole !== "viewer" && !data.hostLocked}
            allowFieldChanges={false}
            mutate={mutate}
            onRefresh={load}
            onError={setError}
          />
        </div>
      )}
    </NodeViewWrapper>
  );
}
export function linkedDatabaseNode(context: () => LinkedEditorContext) {
  return LinkedDatabase.extend({
    addOptions() {
      return { context };
    },
    addNodeView() {
      return ReactNodeViewRenderer(LinkedDatabaseView, {
        stopEvent: () => true,
      });
    },
  });
}
