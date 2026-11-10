"use client";
// "In Text umwandeln" of a lasso selection with the instance's AI
// (lib/ai/handwriting.ts): the selected pen strokes as a picture, shown
// with where it goes; on "Erkennen" the picture is sent, the text comes back
// to edit, then
//   – "Als Text einfügen": a text box in the strokes' place (the text
//     tool's colour, size and face), the strokes go,
//   – "Neben die Handschrift": the strokes stay, the text box goes next to them,
//   – "Kopieren": the text to the clipboard.
// Placing it is one undo step of the ink, saved like every other change.
import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardText, Sparkle, TextAa, TextColumns } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { AiProviderFooter } from "../ai-context";
import { recognizeHandwritingAi } from "@/lib/ai/client";
import type { PageSize } from "@/lib/ink/coords";
import { itemBounds, textBox, unionBox } from "@/lib/ink/geometry";
import { inkId, INK_LIMITS, type InkItem, type InkText } from "@/lib/ink/model";
import { besideBox } from "@/lib/ink/selection";
import { blobBase64, inkAreaPng } from "./ink-image";
import type { InkEditor } from "./use-ink-editor";

type State = { step: "ready" } | { step: "working" } | { step: "done"; text: string } | { step: "failed"; message: string };

export function AiConvertDialog({
  editor,
  page,
  size,
  pageId,
  items,
  onClose,
}: {
  editor: InkEditor;
  page: string;
  size: PageSize;
  pageId: string;
  items: InkItem[];
  onClose: () => void;
}) {
  const t = useT();
  // The strokes as they were when the dialog opened.
  const [pens] = useState(() => items.filter((i) => i.type === "pen"));
  const [png, setPng] = useState<{ blob: Blob; url: string } | null>(null);
  const [state, setState] = useState<State>({ step: "ready" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    let url = "";
    let gone = false;
    void inkAreaPng(pens, { background: "#ffffff" })
      .then((result) => {
        if (gone || !result) return;
        url = URL.createObjectURL(result.blob);
        setPng({ blob: result.blob, url });
      })
      .catch(() => !gone && setState({ step: "failed", message: t("Die Auswahl konnte nicht als Bild erstellt werden.", "The selection could not be turned into a picture.") }));
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
      abort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pens]);

  const recognize = async () => {
    if (!png) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ step: "working" });
    try {
      const text = await recognizeHandwritingAi({ pageId, image: await blobBase64(png.blob) }, controller.signal);
      if (controller.signal.aborted) return;
      setState(text.trim() ? { step: "done", text } : { step: "failed", message: t("In der Auswahl wurde kein Text erkannt.", "No text was recognised in the selection.") });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ step: "failed", message: (error as Error).message || t("Die Handschrift konnte nicht erkannt werden.", "The handwriting could not be recognised.") });
    }
  };

  const box = useMemo(() => unionBox(pens.map(itemBounds)), [pens]);
  // A text box with the text tool's style at (x, y).
  const textItem = (text: string, at: { x: number; y: number }): InkText => {
    const style = editor.textStyle;
    return {
      id: inkId(),
      type: "text",
      color: style.color,
      size: style.width,
      x: Math.round(at.x * 100) / 100,
      y: Math.round(at.y * 100) / 100,
      text: text.slice(0, INK_LIMITS.textLength),
      ...(style.font ? { font: style.font } : {}),
    };
  };
  const place = (mode: "replace" | "beside") => {
    if (state.step !== "done" || !box) return;
    const text = state.text.replace(/\s+$/, "");
    if (!text.trim()) return;
    const ids = new Set(pens.map((p) => p.id));
    let item = textItem(text, { x: box.x, y: box.y });
    if (mode === "beside") {
      const measured = textBox(item);
      item = { ...item, ...besideBox(box, size, { w: measured.w, h: measured.h }) };
    }
    editor.change(page, (list) => (mode === "replace" ? [...list.filter((i) => !ids.has(i.id)), item] : [...list, item]));
    // The new text stays selected: it can be moved at once.
    editor.setSelection({ page, ids: [item.id] });
    onClose();
  };
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (state.step !== "done") return;
    try {
      await navigator.clipboard.writeText(state.text);
      setCopied(true);
    } catch {
      // No clipboard access here: the text stays in the field to copy by hand.
    }
  };

  return (
    <Modal open onClose={onClose} title={t("Handschrift in Text umwandeln", "Convert handwriting to text")} className="ink-ai-convert">
      {png && <img className="ink-ai-convert-preview" src={png.url} alt={t("Die markierte Handschrift", "The selected handwriting")} />}
      {state.step === "done" ? (
        <>
          <label className="ink-ai-convert-label" htmlFor="ink-ai-convert-text">
            {t("Erkannter Text", "Recognised text")}
          </label>
          <textarea
            id="ink-ai-convert-text"
            className="ink-ai-convert-text"
            value={state.text}
            maxLength={INK_LIMITS.textLength}
            rows={Math.min(10, Math.max(3, state.text.split("\n").length + 1))}
            onChange={(e) => {
              setCopied(false);
              setState({ step: "done", text: e.target.value });
            }}
          />
          <div className="modal-actions ink-ai-convert-actions">
            <button type="button" className="button" onClick={() => void copy()}>
              <ClipboardText size={16} /> {copied ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
            </button>
            <button type="button" className="button" disabled={!state.text.trim()} onClick={() => place("beside")}>
              <TextColumns size={16} /> {t("Neben die Handschrift", "Next to the handwriting")}
            </button>
            <button type="button" className="button primary" disabled={!state.text.trim()} onClick={() => place("replace")}>
              <TextAa size={16} /> {t("Als Text einfügen", "Insert as text")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small ink-ai-convert-hint">
            {t(
              "Der markierte Ausschnitt geht als Bild an das eingerichtete KI-Modell; es muss Bilder verstehen. Gespeichert wird erst, was du einfügst.",
              "The selected snippet goes to the configured AI model as a picture; the model must understand images. Nothing is saved until you insert it.",
            )}
          </p>
          {state.step === "failed" && (
            <p className="error" role="alert">
              {state.message}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary" disabled={!png || state.step === "working"} onClick={() => void recognize()}>
              <Sparkle size={16} /> {state.step === "working" ? t("Wird erkannt …", "Recognising …") : t("Erkennen", "Recognise")}
            </button>
          </div>
        </>
      )}
      <AiProviderFooter />
    </Modal>
  );
}
