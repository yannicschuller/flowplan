"use client";
// More buttons in the board's style bar: group and ungroup, italic and
// underline, bullet and numbered lists, a link (web address or an element
// of this board), tags on notes, "Link zu diesem Element kopieren",
// cropping pictures, exporting the selection and saving it as a template.
// While a text is being edited, lists and links go into the text itself.
import { useState } from "react";
import {
  Crop,
  DownloadSimple,
  LinkSimple,
  ListBullets,
  ListNumbers,
  SelectionAll,
  SquaresFour,
  Tag,
  TextItalic,
  TextUnderline,
  Copy,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { safeHref } from "@/lib/whiteboard-links";
import { addTag, boardTags, itemTags, removeTag, tagColor } from "@/lib/whiteboard-tags";
import { frameSequence } from "@/lib/whiteboard-frames";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

type Props = {
  selected: WhiteboardItem[];
  items: WhiteboardItem[];
  canGroup: boolean;
  canUngroup: boolean;
  editingText: boolean;
  onGroup: () => void;
  onUngroup: () => void;
  set: (props: Partial<WhiteboardItem>) => void;
  onList: (kind: "ul" | "ol") => void;
  onTextLink: (href: string) => boolean;
  onTags: (id: string, tags: string[]) => void;
  onCopyLink: (id: string) => void;
  onCrop: (id: string) => void;
  onExport: () => void;
  onSaveTemplate: () => void;
};
// Buttons that must not take the focus from the text being edited.
const keep = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

export function ItemTools(props: Props) {
  const t = useT();
  const { selected, items } = props;
  const [open, setOpen] = useState<"link" | "tags" | null>(null);
  const [link, setLink] = useState("");
  const [tag, setTag] = useState("");
  const first = selected[0];
  if (!first) return null;
  const single = selected.length === 1 ? first : null;
  const types = new Set(selected.map((i) => i.type));
  const textual = [...types].every((type) => type === "sticky" || type === "text" || type === "shape");
  const frames = frameSequence(items).filter((f) => f.id !== single?.id);
  const tags = single?.type === "sticky" ? itemTags(single) : [];
  const suggestions = boardTags(items)
    .map((e) => e.tag)
    .filter((x) => !tags.some((y) => y.toLocaleLowerCase("de") === x.toLocaleLowerCase("de")))
    .slice(0, 8);
  const applyLink = (value: string) => {
    if (!value.trim()) return;
    const href = safeHref(value.trim()) || safeHref(`https://${value.trim()}`);
    if (!href) return;
    if (!props.onTextLink(href)) props.set({ link: href });
    setOpen(null);
    setLink("");
  };
  return (
    <>
      <span className="wb-sep" />
      {props.canGroup && (
        <button aria-label={t("Gruppieren", "Group")} title={t("Gruppieren (Strg/⌘+G)", "Group (Ctrl/⌘+G)")} onClick={props.onGroup}>
          <SquaresFour size={16} />
        </button>
      )}
      {props.canUngroup && (
        <button aria-label={t("Gruppierung aufheben", "Ungroup")} title={t("Gruppierung aufheben (Umschalt+Strg/⌘+G)", "Ungroup (Shift+Ctrl/⌘+G)")} onClick={props.onUngroup}>
          <SelectionAll size={16} />
        </button>
      )}
      {textual && (
        <>
          <button
            {...keep}
            className={first.italic ? "active" : ""}
            aria-pressed={!!first.italic}
            aria-label={t("Kursiv", "Italic")}
            title={t("Kursiv (beim Schreiben: Strg/⌘+I)", "Italic (while typing: Ctrl/⌘+I)")}
            onClick={() => props.set({ italic: !first.italic })}
          >
            <TextItalic size={16} />
          </button>
          <button
            {...keep}
            className={first.underline ? "active" : ""}
            aria-pressed={!!first.underline}
            aria-label={t("Unterstrichen", "Underline")}
            title={t("Unterstrichen (beim Schreiben: Strg/⌘+U)", "Underline (while typing: Ctrl/⌘+U)")}
            onClick={() => props.set({ underline: !first.underline })}
          >
            <TextUnderline size={16} />
          </button>
          <button {...keep} aria-label={t("Aufzählung", "Bulleted list")} title={t("Aufzählung", "Bulleted list")} onClick={() => props.onList("ul")}>
            <ListBullets size={16} />
          </button>
          <button {...keep} aria-label={t("Nummerierte Liste", "Numbered list")} title={t("Nummerierte Liste", "Numbered list")} onClick={() => props.onList("ol")}>
            <ListNumbers size={16} />
          </button>
        </>
      )}
      {single && single.type !== "comment" && (
        <span className="wb-arrange">
          <button
            {...keep}
            className={single.link ? "active" : ""}
            aria-label={t("Link", "Link")}
            aria-expanded={open === "link"}
            title={props.editingText ? t("Link in den Text einfügen", "Insert a link into the text") : t("Link auf dem Element", "Link on the element")}
            onClick={() => {
              setLink(props.editingText ? "" : single.link || "");
              setOpen(open === "link" ? null : "link");
            }}
          >
            <LinkSimple size={16} />
          </button>
          {open === "link" && (
            <span className="wb-arrange-menu wb-link-menu" role="dialog" aria-label={t("Link", "Link")}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  applyLink(link);
                }}
              >
                <input
                  value={link}
                  autoFocus={!props.editingText}
                  onChange={(e) => setLink(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") setOpen(null);
                  }}
                  placeholder={t("https://… oder Element-Link", "https://… or element link")}
                  aria-label={t("Link-Adresse", "Link address")}
                />
                <button className="button compact primary">{t("Setzen", "Set")}</button>
              </form>
              {frames.length > 0 && (
                <>
                  <small>{t("Zu einem Rahmen springen", "Jump to a frame")}</small>
                  {frames.slice(0, 12).map((f) => (
                    <button key={f.id} role="menuitem" {...keep} onClick={() => applyLink(`#item=${f.id}`)}>
                      {f.text || t("Rahmen", "Frame")}
                    </button>
                  ))}
                </>
              )}
              {single.link && !props.editingText && (
                <button
                  role="menuitem"
                  onClick={() => {
                    props.set({ link: undefined });
                    setOpen(null);
                  }}
                >
                  {t("Link entfernen", "Remove link")}
                </button>
              )}
            </span>
          )}
        </span>
      )}
      {single?.type === "sticky" && (
        <span className="wb-arrange">
          <button className={tags.length ? "active" : ""} aria-label={t("Schlagwörter", "Tags")} aria-expanded={open === "tags"} title={t("Schlagwörter", "Tags")} onClick={() => setOpen(open === "tags" ? null : "tags")}>
            <Tag size={16} />
          </button>
          {open === "tags" && (
            <span className="wb-arrange-menu wb-tags-menu" role="dialog" aria-label={t("Schlagwörter", "Tags")}>
              {tags.length > 0 && (
                <span className="wb-tags-edit">
                  {tags.map((x) => {
                    const [bg, fg] = tagColor(x);
                    return (
                      <button
                        key={x}
                        className="wb-tag"
                        style={{ background: bg, color: fg }}
                        aria-label={t(`Schlagwort „${x}“ entfernen`, `Remove tag “${x}”`)}
                        onClick={() => props.onTags(single.id, removeTag(tags, x))}
                      >
                        {x} ×
                      </button>
                    );
                  })}
                </span>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (tag.trim()) props.onTags(single.id, addTag(tags, tag));
                  setTag("");
                }}
              >
                <input
                  value={tag}
                  autoFocus
                  maxLength={40}
                  onChange={(e) => setTag(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") setOpen(null);
                  }}
                  placeholder={t("Neues Schlagwort", "New tag")}
                  aria-label={t("Neues Schlagwort", "New tag")}
                />
                <button className="button compact primary">{t("Hinzufügen", "Add")}</button>
              </form>
              {suggestions.length > 0 && (
                <span className="wb-tags-edit">
                  {suggestions.map((x) => (
                    <button key={x} className="wb-tag suggestion" onClick={() => props.onTags(single.id, addTag(tags, x))}>
                      + {x}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
        </span>
      )}
      {single && (
        <button aria-label={t("Link zu diesem Element kopieren", "Copy link to this element")} title={t("Link zu diesem Element kopieren", "Copy link to this element")} onClick={() => props.onCopyLink(single.id)}>
          <Copy size={16} />
        </button>
      )}
      {single?.type === "image" && (
        <button aria-label={t("Zuschneiden", "Crop")} title={t("Zuschneiden", "Crop")} className={single.crop ? "active" : ""} onClick={() => props.onCrop(single.id)}>
          <Crop size={16} />
        </button>
      )}
      <button aria-label={t("Auswahl exportieren", "Export selection")} title={t("Auswahl exportieren (PNG, SVG, PDF)", "Export selection (PNG, SVG, PDF)")} onClick={props.onExport}>
        <DownloadSimple size={16} />
      </button>
      <button aria-label={t("Auswahl als Vorlage speichern", "Save selection as template")} title={t("Auswahl als Vorlage speichern", "Save selection as template")} onClick={props.onSaveTemplate}>
        <SquaresFour size={16} weight="duotone" />
      </button>
    </>
  );
}
