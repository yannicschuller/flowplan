"use client";
// The bar above a draft of a saved page template (#461,
// lib/template-drafts.ts): what the page is, "Vorlage speichern" writes it
// into the template, "Verwerfen" throws it away. Only its creator ever
// sees a draft.
import { useState } from "react";
import { SquaresFour } from "@phosphor-icons/react";
import { flushOpenDocuments } from "@/lib/document-flush";
import { useT } from "./i18n";
import { api, ApiError, Modal } from "./ui";

export type TemplateDraftInfo = { id: string; name: string; version: number; deleted: boolean; workspaceWide: boolean };

export function TemplateDraftBar({
  draft,
  pageId,
  workspaceId,
  onDone,
  onError,
}: {
  draft: TemplateDraftInfo;
  pageId: string;
  workspaceId: string;
  // Saved into the template or discarded: the draft is gone (the page is
  // left before anything loads it again).
  onDone: (outcome: "saved" | "discarded") => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  // Straight to the server: the app's own command path would reload the
  // open page – the draft, gone by then.
  const send = (body: Record<string, unknown>) => api("/api/command", body);
  const [busy, setBusy] = useState(false),
    [discarding, setDiscarding] = useState(false),
    // The server's answer when a template of the whole workspace would get
    // tags or properties of this space: saved without them on confirming.
    [spaceRefs, setSpaceRefs] = useState("");
  async function save(withoutSpaceMeta = false) {
    setBusy(true);
    try {
      // What was typed a moment ago goes in too.
      await flushOpenDocuments();
      await send({ action: "template.content", workspaceId, templateId: draft.id, pageId, ...(withoutSpaceMeta ? { spaceMeta: "remove" } : {}) });
      setSpaceRefs("");
      onDone("saved");
    } catch (error) {
      if (!withoutSpaceMeta && error instanceof ApiError && error.status === 409 && /spaceMeta/.test(error.message)) setSpaceRefs(error.message);
      else onError(error);
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    setBusy(true);
    try {
      await send({ action: "template.draft.discard", pageId });
      setDiscarding(false);
      onDone("discarded");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-review-banner template-draft-bar" role="status">
        <SquaresFour aria-hidden />
        <span>
          {draft.deleted
            ? t(
                `Entwurf der Vorlage „${draft.name}“ – die Vorlage liegt im Vorlagen-Papierkorb. Stelle sie wieder her, um den Entwurf zu speichern.`,
                `Draft of the template “${draft.name}” – the template is in the template trash. Restore it to save the draft.`,
              )
            : t(
                `Entwurf der Vorlage „${draft.name}“ – nur du siehst ihn. „Vorlage speichern“ ersetzt den Inhalt der Vorlage; bereits erstellte Seiten werden nicht verändert.`,
                `Draft of the template “${draft.name}” – only you see it. “Save template” replaces the template's content; pages already created are not changed.`,
              )}
        </span>
        <button type="button" className="button compact" disabled={busy} onClick={() => setDiscarding(true)}>
          {t("Verwerfen", "Discard")}
        </button>
        <button type="button" className="button primary compact" disabled={busy || draft.deleted} onClick={() => void save()}>
          {t("Vorlage speichern", "Save template")}
        </button>
      </div>
      {spaceRefs && (
        <div className="callout template-draft-refs" role="alert">
          <p>
            {spaceRefs} {t("Beim Speichern werden sie aus der Vorlage genommen.", "Saving takes them out of the template.")}
          </p>
          <div className="modal-actions">
            <button type="button" className="button compact" disabled={busy} onClick={() => setSpaceRefs("")}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary compact" disabled={busy} onClick={() => void save(true)}>
              {t("Ohne sie speichern", "Save without them")}
            </button>
          </div>
        </div>
      )}
      <Modal open={discarding} onClose={() => !busy && setDiscarding(false)} title={t("Entwurf verwerfen", "Discard draft")}>
        <p>
          {t(
            `Den Entwurf verwerfen? Deine Änderungen gehen verloren; die Vorlage „${draft.name}“ bleibt, wie sie ist.`,
            `Discard the draft? Your changes are lost; the template “${draft.name}” stays as it is.`,
          )}
        </p>
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={() => setDiscarding(false)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button danger" disabled={busy} onClick={() => void discard()}>
            {t("Verwerfen", "Discard")}
          </button>
        </div>
      </Modal>
    </>
  );
}
