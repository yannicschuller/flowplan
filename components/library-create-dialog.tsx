"use client";
// A library's own small dialog (#329): "Neues Buch", "Neues Kapitel" and
// "Neue Seite" ask for the name only – the shelf, the book and the kind
// (a document) are given by where it was opened. A page from the book's
// overview also asks for its chapter. Loaded with the library
// (components/library-view.tsx). The box keeps its top edge while it grows
// or shrinks (app/library.css), a message inside does not move it.
import { useRef, useState, type FormEvent } from "react";
import { BookOpen, Books, FileText, type Icon } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";

export type LibraryCreate =
  | { kind: "book" }
  | { kind: "chapter"; bookTitle: string; parentId: string }
  // In a chapter (parentId) or, from the book's overview, in one of its
  // chapters to choose (the last one first).
  | { kind: "page"; parentId: string; chapters?: { id: string; title: string }[]; place?: string };

export function LibraryCreateDialog({
  create,
  shelf,
  onClose,
  onCreate,
}: {
  create: LibraryCreate | null;
  shelf: string;
  onClose: () => void;
  // Creates it; the id, or null when it failed (the message shows in the dialog).
  onCreate: (parentId: string | null, title: string) => Promise<string | null>;
}) {
  const t = useT();
  const kind = create?.kind ?? "book";
  const [title, setTitle] = useState("");
  const [chapter, setChapter] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Reset with each opening (the state of the last one stays otherwise).
  const [opened, setOpened] = useState<LibraryCreate | null>(null);
  if (opened !== create) {
    setOpened(create);
    setTitle("");
    setBusy(false);
    setChapter(create?.kind === "page" && create.chapters?.length ? create.chapters[create.chapters.length - 1].id : "");
  }
  const text: Record<typeof kind, { title: string; label: string; placeholder: string; submit: string; icon: Icon; where: string }> = {
    book: {
      title: t("Neues Buch", "New book"),
      label: t("Name des Buchs", "Name of the book"),
      placeholder: t("Wie heißt dein Buch?", "What is your book called?"),
      submit: t("Buch erstellen", "Create book"),
      icon: Books,
      where: t(`Im Regal „${shelf}“`, `On the shelf “${shelf}”`),
    },
    chapter: {
      title: t("Neues Kapitel", "New chapter"),
      label: t("Name des Kapitels", "Name of the chapter"),
      placeholder: t("Wie heißt dein Kapitel?", "What is your chapter called?"),
      submit: t("Kapitel erstellen", "Create chapter"),
      icon: BookOpen,
      where: create?.kind === "chapter" ? t(`Im Buch „${create.bookTitle}“`, `In the book “${create.bookTitle}”`) : "",
    },
    page: {
      title: t("Neue Seite", "New page"),
      label: t("Name der Seite", "Name of the page"),
      placeholder: t("Wie heißt deine Seite?", "What is your page called?"),
      submit: t("Seite erstellen", "Create page"),
      icon: FileText,
      where: create?.kind === "page" && create.place ? t(`Im Kapitel „${create.place}“`, `In the chapter “${create.place}”`) : "",
    },
  };
  const shown = text[kind];
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!create || busy) return;
    const parentId = create.kind === "book" ? null : create.kind === "page" && create.chapters ? chapter : create.parentId;
    if (create.kind !== "book" && !parentId) return;
    setBusy(true);
    try {
      if (!(await onCreate(parentId, title.trim() || t("Ohne Titel", "Untitled")))) setBusy(false);
    } catch {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!create}
      sheet
      onClose={onClose}
      title={shown.title}
      className="library-create"
      // The name first, on phones as well.
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        field.current?.focus();
      }}
    >
      <form className="library-create-form" onSubmit={submit}>
        {shown.where && (
          <p className="library-create-where">
            <shown.icon size={15} aria-hidden /> {shown.where}
          </p>
        )}
        <label className="library-create-field">
          {shown.label}
          <input ref={field} autoFocus value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} placeholder={shown.placeholder} enterKeyHint="done" />
        </label>
        {create?.kind === "page" && create.chapters && (
          <label className="library-create-field">
            {t("Kapitel", "Chapter")}
            <Select value={chapter} onChange={(e) => setChapter(e.target.value)}>
              {create.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || t("Ohne Titel", "Untitled")}
                </option>
              ))}
            </Select>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy}>
            {shown.submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}
