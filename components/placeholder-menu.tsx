"use client";
// "Platzhalter einfügen" beside a record's content: the database's
// properties and the built-ins as "{{Name}}" at the cursor. Saved as a
// record template, they become the values of each record the template is
// applied to (lib/record-placeholders.ts).
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { BracketsCurly } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import { safeCollisionPadding } from "./safe-area";
import { useLocale, useT } from "./i18n";
import { BUILTINS, type Builtin } from "@/lib/record-placeholders";
import { readRestricted } from "@/lib/field-access-rules";
import type { Field } from "@/lib/types";

// The editor of a document inside `root` (Tiptap keeps it on its element).
export function editorIn(root: HTMLElement | null): Editor | null {
  const dom = root?.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  return dom?.editor && !dom.editor.isDestroyed ? dom.editor : null;
}

export function PlaceholderMenu({ fields, onInsert }: { fields: Field[]; onInsert: (text: string) => void }) {
  const t = useT();
  const locale = useLocale();
  // Properties only some people may read stay empty in templates.
  const shown = fields.filter((f) => !readRestricted(f.access));
  const labels: Record<Builtin, string> = {
    title: t("Titel des Eintrags", "Title of the record"),
    today: t("Heutiges Datum", "Today's date"),
    now: t("Datum und Uhrzeit", "Date and time"),
    creator: t("Wer den Eintrag erstellt hat", "Who created the record"),
    me: t("Wer die Vorlage anwendet", "Who applies the template"),
    database: t("Name der Datenbank", "Name of the database"),
  };
  const insert = (token: string) => () => {
    // After the menu has closed and given focus back.
    setTimeout(() => onInsert(`{{${token}}}`), 0);
  };
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          className="icon-button placeholder-menu-button"
          aria-label={t("Platzhalter einfügen", "Insert placeholder")}
          title={t("Platzhalter einfügen – für Datensatzvorlagen", "Insert placeholder – for record templates")}
        >
          <BracketsCurly size={18} />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          collisionPadding={safeCollisionPadding()}
          className="dropdown placeholder-menu"
          align="end"
          sideOffset={4}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Dropdown.Label className="menu-label">{t("Eigenschaften", "Properties")}</Dropdown.Label>
          {shown.map((f) => (
            <Dropdown.Item key={f.id} className="dropdown-item" onSelect={insert(f.name)}>
              <code>{`{{${f.name}}}`}</code>
            </Dropdown.Item>
          ))}
          <Dropdown.Separator className="dropdown-separator" />
          <Dropdown.Label className="menu-label">{t("Allgemein", "General")}</Dropdown.Label>
          {BUILTINS.map((b) => {
            const token = b.token[locale as keyof typeof b.token] || b.token.en;
            return (
              <Dropdown.Item key={b.key} className="dropdown-item" onSelect={insert(token)}>
                <code>{`{{${token}}}`}</code>
                <span className="muted">{labels[b.key]}</span>
              </Dropdown.Item>
            );
          })}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
