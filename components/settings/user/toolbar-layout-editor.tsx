"use client";
// "Formatierungsleiste anpassen" (#292, lib/toolbar-layout.ts) in Settings →
// Darstellung & Sprache → Editor, and "Standard-Formatierungsleiste" in
// Administration → Instanz (components/settings/admin/
// toolbar-layout-default.tsx) with the same editor: a preview of the
// toolbar as it will look, every button with a checkbox to show or hide
// it, moved by dragging its handle or with the up and down buttons
// (keyboard, screen readers); buttons put together into a group (one
// toolbar button with a menu of them), the two groups of the issue as
// presets; dividers inserted ("Trennlinie einfügen", or after an entry)
// and removed again; the blocks of the "/" menu to add as buttons; a line
// saying whether the toolbar is customized and "Zurücksetzen" for the
// default. Each change is saved right away.
import { useState, type DragEvent, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowCounterClockwise, ArrowDown, ArrowSquareOut, ArrowUp, CaretDown, DotsSixVertical, LineVertical, LinkBreak, Stack, X } from "@phosphor-icons/react";
import {
  addToolbarDivider,
  applyGroupPreset,
  blocksOutside,
  canGroupWithNext,
  dividerPlaces,
  groupWithNext,
  hasGroupPreset,
  isDefaultToolbarLayout,
  isToolbarBlock,
  isToolbarGroup,
  moveInGroup,
  moveToolbarEntry,
  removeToolbarEntry,
  sameToolbarLayout,
  setToolbarItemShown,
  takeOutOfGroup,
  toolbarEntries,
  toolbarLayoutOf,
  TOOLBAR_DIVIDER,
  TOOLBAR_GROUP_PRESETS,
  ungroupToolbarEntry,
  type GroupableItem,
  type ToolbarEntry,
  type ToolbarGroupPreset,
  type ToolbarItem,
  type ToolbarLayout,
} from "@/lib/toolbar-layout";
import { blockStyleShort } from "@/lib/toolbar-format";
import { toolbarGroupLabel, toolbarItemLabels, toolbarPresetLabel } from "@/lib/toolbar-layout-labels";
import { saveToolbarLayout, setToolbarLayoutLocal, toolbarLayout, useToolbarLayoutState } from "@/lib/toolbar-layout-client";
import { ALIGN_PREVIEW_ICON, IMAGE_TOOL_ICONS, TOOLBAR_BLOCK_ICONS, TOOLBAR_BUTTON_ICONS } from "../../toolbar-icons";
import { ToolbarGroupMenu } from "../../format-menus";
import { safeCollisionPadding } from "../../safe-area";
import { useT } from "../../i18n";
import { SaveState, SettingRow, useSaveState } from "../../settings-ui";

// Rows dragged here carry their index under a type of their own.
const DRAG_TYPE = "application/x-flowplan-toolbar-entry";
// Buttons that toggle (checkbox entries in a group's menu, as in the editor).
const TOGGLES = new Set<string>(["bold", "italic", "underline", "strike", "highlight", "superscript", "subscript", "spoiler", "suggest", "authors", "bulletList", "orderedList", "taskList"]);

// The person's own layout: the editor on the client store, saved with
// profile.toolbarLayout. Reset goes back to the instance's default.
export function ToolbarLayoutEditor({ save }: { save: (layout: ToolbarLayout | null) => Promise<unknown> }) {
  const t = useT();
  const { layout, standard, custom } = useToolbarLayoutState();
  const instance = !isDefaultToolbarLayout(standard);
  return (
    <ToolbarLayoutCustomizer
      anchor="toolbar-layout"
      label={t("Formatierungsleiste anpassen", "Customize formatting toolbar")}
      description={t(
        "Wähle, welche Schaltflächen die Leiste zeigt und in welcher Reihenfolge. Fasse Schaltflächen zu einer Gruppe zusammen – sie erscheint als eine Schaltfläche mit einem kleinen Menü – oder trenne Gruppen mit Trennlinien. Ziehe eine Zeile am Griff oder verschiebe sie mit den Pfeilen. Gilt auf allen Geräten, auch für die Leiste über der Tastatur auf dem Handy.",
        "Choose which buttons the bar shows and in which order. Put buttons together in a group – it shows as one button with a small menu – or separate groups with dividers. Drag a row by its handle or move it with the arrows. Applies on all devices, also to the bar above the keyboard on a phone.",
      )}
      layout={layout}
      resetTo={standard}
      state={custom ? "custom" : instance ? "instance" : "default"}
      resetNote={
        instance
          ? t("Die Leiste zeigt wieder den Standard der Instanz.", "The bar shows the instance default again.")
          : t("Die Leiste zeigt wieder die ursprünglichen Schaltflächen in der ursprünglichen Reihenfolge.", "The bar shows the original buttons in the original order again.")
      }
      commit={async (next, reset) => {
        const before = toolbarLayout();
        setToolbarLayoutLocal(next);
        try {
          await saveToolbarLayout((now) => save(reset && sameToolbarLayout(now, standard) ? null : now));
        } catch (e) {
          setToolbarLayoutLocal(before);
          throw e;
        }
      }}
    />
  );
}

export type ToolbarLayoutState = "custom" | "instance" | "default";

export function ToolbarLayoutCustomizer({
  anchor,
  label,
  description,
  layout,
  resetTo,
  state,
  resetNote,
  commit,
}: {
  anchor: string;
  label: string;
  description: string;
  layout: ToolbarLayout;
  // What "Zurücksetzen" applies, and whether there is anything to reset.
  resetTo: ToolbarLayout;
  state: ToolbarLayoutState;
  resetNote: string;
  // Shows the layout at once and saves it; throws (after undoing) if that fails.
  commit: (next: ToolbarLayout, reset: boolean) => Promise<void>;
}) {
  const t = useT();
  const [status, run] = useSaveState();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const labels = toolbarItemLabels(t);
  const hidden = new Set(layout.hidden);
  const { order } = layout;
  const editorId = `${anchor}-editor`;
  const groupName = (group: readonly GroupableItem[]) => toolbarGroupLabel(group, (item) => labels[item], t);
  const nameOfEntry = (entry: ToolbarEntry) =>
    entry === TOOLBAR_DIVIDER ? t("Trennlinie", "Divider") : isToolbarGroup(entry) ? t(`Gruppe ${groupName(entry)}`, `Group ${groupName(entry)}`) : labels[entry];

  // The layout as it then applies (dividers tidied, …), for the messages.
  const apply = (raw: ToolbarLayout, reset = false) => {
    const next = toolbarLayoutOf(raw, resetTo);
    void run(() => commit(next, reset));
    return next;
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const name = nameOfEntry(order[from]);
    // Dividers at an end or next to each other fall away (tidied), so the
    // place is read back from what now applies.
    const now = apply(moveToolbarEntry(layout, from, to)).order;
    const at = Math.min(to, now.length - 1) + 1;
    setNote(t(`„${name}“ steht jetzt an Position ${at} von ${now.length}.`, `“${name}” is now at position ${at} of ${now.length}.`));
  };
  // A divider moves only between two entries: not to either end.
  const canMove = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= order.length) return false;
    if (order[index] === TOOLBAR_DIVIDER) return to > 0 && to < order.length - 1 && order[to + delta] !== TOOLBAR_DIVIDER;
    return true;
  };
  const insertDivider = (index: number) => {
    const name = nameOfEntry(order[index]);
    apply(addToolbarDivider(layout, index));
    setNote(t(`Trennlinie nach „${name}“ eingefügt.`, `Divider inserted after “${name}”.`));
  };

  const onDragStart = (index: number) => (event: DragEvent) => {
    setDragging(index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TYPE, String(index));
  };
  const onDragOver = (index: number) => (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (over !== index) setOver(index);
  };
  const onDrop = (index: number) => (event: DragEvent) => {
    event.preventDefault();
    const from = Number(event.dataTransfer.getData(DRAG_TYPE));
    if (event.dataTransfer.getData(DRAG_TYPE) !== "" && Number.isInteger(from)) move(from, index);
    setDragging(null);
    setOver(null);
  };
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

  const checkbox = (item: ToolbarItem) => (
    <label className="toolbar-layout-check">
      <input
        type="checkbox"
        checked={!hidden.has(item)}
        onChange={(e) => {
          apply(setToolbarItemShown(layout, item, e.target.checked));
          if (isToolbarBlock(item) && !e.target.checked && order.includes(item))
            setNote(t(`„${labels[item]}“ ist nicht mehr in der Leiste.`, `“${labels[item]}” is no longer in the bar.`));
        }}
      />
      <span>{labels[item]}</span>
    </label>
  );
  const upDown = (name: string, up: boolean, down: boolean, onUp: () => void, onDown: () => void) => (
    <>
      <button type="button" className="icon-button" aria-label={t(`${name} nach oben`, `Move ${name} up`)} title={t("Nach oben", "Move up")} disabled={!up} onClick={onUp}>
        <ArrowUp size={16} />
      </button>
      <button type="button" className="icon-button" aria-label={t(`${name} nach unten`, `Move ${name} down`)} title={t("Nach unten", "Move down")} disabled={!down} onClick={onDown}>
        <ArrowDown size={16} />
      </button>
    </>
  );
  // Divider after and grouping with the next entry: for buttons and groups.
  const entryTools = (index: number, name: string) => (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={t(`Trennlinie nach ${name} einfügen`, `Insert divider after ${name}`)}
        title={t("Trennlinie danach", "Divider after")}
        disabled={index >= order.length - 1 || order[index + 1] === TOOLBAR_DIVIDER}
        onClick={() => insertDivider(index)}
      >
        <LineVertical size={16} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t(`${name} mit der nächsten Schaltfläche gruppieren`, `Group ${name} with the next button`)}
        title={t("Mit der nächsten Schaltfläche gruppieren", "Group with the next button")}
        disabled={!canGroupWithNext(layout, index)}
        onClick={() => {
          apply(groupWithNext(layout, index));
          setNote(t(`„${name}“ ist jetzt in einer Gruppe.`, `“${name}” is now in a group.`));
        }}
      >
        <Stack size={16} />
      </button>
    </>
  );
  const presets = Object.keys(TOOLBAR_GROUP_PRESETS) as ToolbarGroupPreset[];
  const places = dividerPlaces(layout);
  const outside = blocksOutside(layout);

  // The toolbar as it will look: the editor's icons and group menus,
  // without an editor – only a group's menu opens, to show its buttons.
  const iconOf = (item: ToolbarItem): ReactNode => {
    if (isToolbarBlock(item)) {
      const Icon = TOOLBAR_BLOCK_ICONS[item];
      return <Icon />;
    }
    if (item === "heading" || item === "align" || item === "mediaWidth" || item === "imageTools") return null;
    return TOOLBAR_BUTTON_ICONS[item]();
  };
  const inert = (key: string, title: string, children: ReactNode, className = "") => (
    <button key={key} type="button" className={className} title={title} aria-label={title} aria-disabled="true" tabIndex={-1}>
      {children}
    </button>
  );
  const previewItem = (item: ToolbarItem): ReactNode => {
    const caret = <CaretDown className="toolbar-menu-caret" weight="bold" aria-hidden />;
    if (item === "heading")
      return inert(item, labels[item], <><span className="toolbar-menu-text">{blockStyleShort("paragraph")}</span>{caret}</>, "toolbar-menu-button toolbar-heading-menu");
    if (item === "align") return inert(item, labels[item], <>{ALIGN_PREVIEW_ICON()}{caret}</>, "toolbar-menu-button toolbar-align-menu");
    if (item === "mediaWidth") return inert(item, labels[item], <span className="toolbar-layout-preview-width">100 %</span>, "toolbar-menu-button");
    if (item === "imageTools") return IMAGE_TOOL_ICONS.map((icon, i) => inert(`${item}-${i}`, labels[item], icon()));
    return inert(item, labels[item], iconOf(item));
  };
  const preview = (
    <div className="editor-toolbar toolbar-layout-preview" role="group" aria-label={t("Vorschau der Formatierungsleiste", "Preview of the formatting toolbar")}>
      {toolbarEntries(layout).map((entry, i) =>
        entry === TOOLBAR_DIVIDER ? (
          <span key={`divider-${i}`} className="toolbar-separator" role="separator" />
        ) : isToolbarGroup(entry) ? (
          <ToolbarGroupMenu
            key={entry.join("+")}
            editor={null}
            preview
            label={groupName(entry)}
            entries={entry.map((item) => ({ key: item, label: labels[item], icon: iconOf(item), run: () => {}, active: TOGGLES.has(item) ? false : undefined }))}
          />
        ) : (
          previewItem(entry)
        ),
      )}
    </div>
  );

  return (
    <SettingRow anchor={anchor} wide label={label} description={description}>
      <div className="toolbar-layout">
        <p className="toolbar-layout-status" data-state={state}>
          {state === "custom" ? t("Angepasst", "Customized") : state === "instance" ? t("Standard der Instanz", "Instance default") : t("Standard", "Default")}
        </p>
        <div className="toolbar-layout-actions">
          <button type="button" className="button" aria-expanded={open} aria-controls={editorId} onClick={() => setOpen(!open)}>
            {open ? t("Fertig", "Done") : t("Anpassen …", "Customize …")}
          </button>
          <button
            type="button"
            className="button"
            disabled={state !== "custom"}
            onClick={() => {
              apply(resetTo, true);
              setNote(resetNote);
            }}
          >
            <ArrowCounterClockwise size={16} aria-hidden />
            {t("Zurücksetzen", "Reset")}
          </button>
          <SaveState status={status} />
        </div>
        {open && (
          <div id={editorId} className="toolbar-layout-editor">
            {preview}
            <div className="toolbar-layout-presets" role="group" aria-label={t("Fertige Gruppen", "Ready-made groups")}>
              <span className="toolbar-layout-presets-label">{t("Fertige Gruppen:", "Ready-made groups:")}</span>
              {presets.map((preset) => {
                const name = toolbarPresetLabel(preset, t);
                return (
                  <button
                    key={preset}
                    type="button"
                    className="button"
                    aria-label={t(`Gruppe „${name}“ anlegen`, `Create group “${name}”`)}
                    disabled={hasGroupPreset(layout, preset)}
                    onClick={() => {
                      apply(applyGroupPreset(layout, preset));
                      setNote(t(`Gruppe „${name}“ angelegt.`, `Group “${name}” created.`));
                    }}
                  >
                    <Stack size={16} aria-hidden />
                    {name}
                  </button>
                );
              })}
              {/* A divider after a chosen entry; it can be moved and
                  removed in the list afterwards. */}
              <Dropdown.Root modal={false}>
                <Dropdown.Trigger asChild>
                  <button type="button" className="button" disabled={!places.length}>
                    <LineVertical size={16} aria-hidden />
                    {t("Trennlinie einfügen", "Add divider")}
                  </button>
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content className="dropdown" align="start" sideOffset={6} collisionPadding={safeCollisionPadding()}>
                    <Dropdown.Label className="toolbar-layout-menu-label">{t("Trennlinie einfügen nach …", "Add divider after …")}</Dropdown.Label>
                    {places.map((index) => (
                      <Dropdown.Item key={index} className="dropdown-item" onSelect={() => insertDivider(index)}>
                        {nameOfEntry(order[index])}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            </div>
            <ol className="toolbar-layout-list" aria-label={t("Schaltflächen der Formatierungsleiste", "Buttons of the formatting toolbar")}>
              {order.map((entry, index) => {
                const divider = entry === TOOLBAR_DIVIDER;
                const group = isToolbarGroup(entry) ? entry : null;
                const name = nameOfEntry(entry);
                const className = `toolbar-layout-item${divider ? " divider" : ""}${group ? " group" : ""}${dragging === index ? " dragging" : ""}${over === index && dragging !== null && dragging !== index ? (dragging < index ? " drop-after" : " drop-before") : ""}`;
                return (
                  <li key={group ? group.join("+") : divider ? `divider-${index}` : (entry as string)} className={className} data-entry={group ? group.join("+") : (entry as string)} onDragOver={onDragOver(index)} onDrop={onDrop(index)}>
                    <span className="toolbar-layout-handle" draggable onDragStart={onDragStart(index)} onDragEnd={endDrag} title={t("Ziehen zum Verschieben", "Drag to move")} aria-hidden>
                      <DotsSixVertical size={16} />
                    </span>
                    {divider ? (
                      <span className="toolbar-layout-divider-label">
                        <LineVertical size={16} aria-hidden />
                        {name}
                      </span>
                    ) : group ? (
                      <span className="toolbar-layout-group-label">
                        <Stack size={16} aria-hidden />
                        {name}
                      </span>
                    ) : (
                      checkbox(entry as ToolbarItem)
                    )}
                    <span className="ws-order-buttons">
                      {upDown(name, canMove(index, -1), canMove(index, 1), () => move(index, index - 1), () => move(index, index + 1))}
                      {divider ? (
                        <button
                          type="button"
                          className="button toolbar-layout-remove"
                          aria-label={t("Trennlinie entfernen", "Remove divider")}
                          title={t("Trennlinie entfernen", "Remove divider")}
                          onClick={() => {
                            apply(removeToolbarEntry(layout, index));
                            setNote(t("Trennlinie entfernt.", "Divider removed."));
                          }}
                        >
                          <X size={16} aria-hidden />
                          {t("Entfernen", "Remove")}
                        </button>
                      ) : (
                        entryTools(index, name)
                      )}
                      {group && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t(`${name} auflösen`, `Ungroup ${name}`)}
                          title={t("Gruppe auflösen", "Ungroup")}
                          onClick={() => {
                            apply(ungroupToolbarEntry(layout, index));
                            setNote(t("Gruppe aufgelöst.", "Group ungrouped."));
                          }}
                        >
                          <LinkBreak size={16} />
                        </button>
                      )}
                    </span>
                    {group && (
                      <ol className="toolbar-layout-members" aria-label={name}>
                        {group.map((item, member) => (
                          <li key={item} className="toolbar-layout-item member" data-entry={item}>
                            {checkbox(item)}
                            <span className="ws-order-buttons">
                              {upDown(
                                labels[item],
                                member > 0,
                                member < group.length - 1,
                                () => apply(moveInGroup(layout, index, member, member - 1)),
                                () => apply(moveInGroup(layout, index, member, member + 1)),
                              )}
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={t(`${labels[item]} aus der Gruppe nehmen`, `Take ${labels[item]} out of the group`)}
                                title={t("Aus der Gruppe nehmen", "Take out of the group")}
                                onClick={() => {
                                  apply(takeOutOfGroup(layout, index, member));
                                  setNote(t(`„${labels[item]}“ steht jetzt nach der Gruppe.`, `“${labels[item]}” now follows the group.`));
                                }}
                              >
                                <ArrowSquareOut size={16} />
                              </button>
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ol>
            {/* The blocks of the "/" menu not in the bar: checked, one goes
                to the end of the list above. */}
            <div className="toolbar-layout-blocks" role="group" aria-labelledby={`${anchor}-blocks`}>
              <h4 id={`${anchor}-blocks`} className="toolbar-layout-blocks-title">
                {t("Blöcke", "Blocks")}
              </h4>
              <p className="toolbar-layout-blocks-hint">
                {t(
                  "Jeder Block aus dem „/“-Menü kann eine eigene Schaltfläche bekommen: Ein Klick darauf fügt ihn ein. Hake einen Block an, er erscheint dann am Ende der Liste oben.",
                  "Every block of the “/” menu can get a button of its own: a click on it inserts the block. Tick a block and it appears at the end of the list above.",
                )}
              </p>
              {outside.length ? (
                <ul className="toolbar-layout-block-list" aria-label={t("Blöcke, die nicht in der Leiste sind", "Blocks not in the bar")}>
                  {outside.map((block) => {
                    const Icon = TOOLBAR_BLOCK_ICONS[block];
                    return (
                      <li key={block} data-entry={block}>
                        <label className="toolbar-layout-check">
                          <input
                            type="checkbox"
                            checked={false}
                            onChange={() => {
                              apply(setToolbarItemShown(layout, block, true));
                              setNote(t(`„${labels[block]}“ steht jetzt am Ende der Leiste.`, `“${labels[block]}” is now at the end of the bar.`));
                            }}
                          />
                          <Icon size={16} />
                          <span>{labels[block]}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="toolbar-layout-blocks-hint">{t("Alle Blöcke sind in der Leiste.", "All blocks are in the bar.")}</p>
              )}
            </div>
          </div>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {note}
        </p>
      </div>
    </SettingRow>
  );
}
