"use client";
// A synced block inside a document: the content of its synced page, edited
// right here with its own live editor. Changes show up on every page that
// shows the block.
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ArrowsClockwise, ArrowSquareOut, Trash } from "@phosphor-icons/react";
import { SyncedBlock } from "@/lib/document-schema";
import type { Page, User } from "@/lib/types";

const DocumentEditor = dynamic(() => import("./editor"), { ssr: false });

export type SyncedContext = {
  userId: string;
  pages: Page[];
  members: User[];
  editable: boolean;
  onError: (message: string) => void;
};
type Loaded = {
  page: Page;
  role: string;
  state: string | null;
  html: string;
  generation: string;
  syncedUsage?: {
    count: number;
    hosts: { id: string; title: string }[];
    origin: { id: string; title: string } | null;
  };
};

function SyncedView({ node, deleteNode, extension, editor, selected }: NodeViewProps) {
  const t = useT();
  const context = (extension.options as { context: () => SyncedContext }).context();
  const pageId = String(node.attrs.pageId || "");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/pages/${pageId}`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? t("Dieser synchronisierte Block wurde gelöscht.", "This synced block was deleted.")
              : response.status === 403
                ? t("Du hast keinen Zugriff auf diesen synchronisierten Block.", "You have no access to this synced block.")
                : body.error || t("Nicht verfügbar", "Not available"),
          );
        if (alive) {
          setData(body);
          setError("");
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [pageId]);
  const others = Math.max(0, (data?.syncedUsage?.count || 1) - 1);
  const canEdit = context.editable && data?.role !== "viewer" && !data?.page.locked;
  return (
    <NodeViewWrapper className={`synced-block${selected ? " selected" : ""}`} data-drag-handle="">
      <div className="synced-block-bar" contentEditable={false}>
        <ArrowsClockwise size={13} />
        <span>
          {t("Synchronisiert", "Synced")}
          {others > 0 && t(` · auf ${others + 1} Seiten`, ` · on ${others + 1} pages`)}
        </span>
        {data?.syncedUsage?.origin && (
          <a href={`/#page=${data.syncedUsage.origin.id}`} title={t("Seite, auf der der Block entstanden ist", "Page where the block was created")}>
            <ArrowSquareOut size={13} /> {data.syncedUsage.origin.title || t("Ohne Titel", "Untitled")}
          </a>
        )}
        {editor.isEditable && (
          <button
            type="button"
            className="icon-button"
            aria-label={t("Synchronisierten Block hier entfernen", "Remove synced block here")}
            title={t("Nur hier entfernen – der Inhalt bleibt an den anderen Stellen", "Remove only here – the content stays in the other places")}
            onClick={() => deleteNode()}
          >
            <Trash size={13} />
          </button>
        )}
      </div>
      {error ? (
        <p className="synced-block-error">{error}</p>
      ) : !data ? (
        <p className="muted synced-block-loading">{t("Wird geladen …", "Loading …")}</p>
      ) : (
        <DocumentEditor
          key={`${pageId}-${data.generation}`}
          embedded
          pageId={pageId}
          userId={context.userId}
          pages={context.pages}
          members={context.members}
          state={data.state}
          html={data.html}
          generation={data.generation}
          editable={!!canEdit}
          onStatus={() => {}}
          onError={context.onError}
          onHtml={() => {}}
        />
      )}
    </NodeViewWrapper>
  );
}

export const syncedBlockNode = (context: () => SyncedContext) =>
  SyncedBlock.extend({
    addOptions() {
      return { context };
    },
    addNodeView() {
      return ReactNodeViewRenderer(SyncedView, {
        // The inner editor handles its own keys, clicks and changes.
        stopEvent: ({ event }) => !(event.target as HTMLElement)?.closest?.(".synced-block-bar"),
        ignoreMutation: () => true,
      });
    },
  });
