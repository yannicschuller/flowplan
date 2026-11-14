"use client";
// "Formatierungsleiste anpassen" (#292, lib/toolbar-layout.ts) in Settings →
// Darstellung & Sprache → Editor: every button of the formatting toolbar
// with a checkbox to show or hide it, moved by dragging its handle or with
// the up and down buttons (keyboard, screen readers); buttons put together
// into a group (one toolbar button with a menu of them), the two groups of
// the issue as presets; dividers inserted after an entry and removed again;
// "Zurücksetzen" for the default. Each change is saved right away
// (profile, all devices).
import { useState, type DragEvent } from "react";
import { ArrowCounterClockwise, ArrowDown, ArrowSquareOut, ArrowUp, DotsSixVertical, LineVertical, LinkBreak, Stack, X } from "@phosphor-icons/react";
import {
  addToolbarDivider,
  applyGroupPreset,
  canGroupWithNext,
  defaultToolbarLayout,
  groupWithNext,
  hasGroupPreset,
  isDefaultToolbarLayout,
  isToolbarGroup,
  moveInGroup,
  moveToolbarEntry,
  removeToolbarEntry,
  setToolbarItemShown,
  takeOutOfGroup,
  TOOLBAR_DIVIDER,
  TOOLBAR_GROUP_PRESETS,
  ungroupToolbarEntry,
  type ToolbarEntry,
  type ToolbarGroupPreset,
  type ToolbarItem,
  type ToolbarLayout,
} from "@/lib/toolbar-layout";
import { toolbarGroupLabel, toolbarItemLabels, toolbarPresetLabel } from "@/lib/toolbar-layout-labels";
import { saveToolbarLayout, setToolbarLayoutLocal, toolbarLayout, useToolbarLayout } from "@/lib/toolbar-layout-client";
import { useT } from "../../i18n";
import { SaveState, SettingRow, useSaveState } from "../../settings-ui";

// Rows dragged here carry their index under a type of their own.
const DRAG_TYPE = "application/x-flowplan-toolbar-entry";

export function ToolbarLayoutEditor({ save }: { save: (layout: ToolbarLayout | null) => Promise<unknown> }) {
  const t = useT();
  const layout = useToolbarLayout();
  const [status, run] = useSaveState();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const labels = toolbarItemLabels(t);
  const hidden = new Set(layout.hidden);
  const { order } = layout;
  const nameOfEntry = (entry: ToolbarEntry) =>
    entry === TOOLBAR_DIVIDER
      ? t("Trennlinie", "Divider")
      : isToolbarGroup(entry)
        ? t(`Gruppe ${toolbarGroupLabel(entry, (item) => labels[item], t)}`, `Group ${toolbarGroupLabel(entry, (item) => labels[item], t)}`)
        : labels[entry];

  const apply = (next: ToolbarLayout, reset = false) => {
    const before = toolbarLayout();
    setToolbarLayoutLocal(next);
    void run(async () => {
      try {
        await saveToolbarLayout((now) => save(reset && isDefaultToolbarLayout(now) ? null : now));
      } catch (e) {
        setToolbarLayoutLocal(before);
        throw e;
      }
    });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const name = nameOfEntry(order[from]);
    apply(moveToolbarEntry(layout, from, to));
    // Dividers at an end or next to each other fall away (tidied), so the
    // place is read back from what now applies.
    const now = toolbarLayout().order;
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
      <input type="checkbox" checked={!hidden.has(item)} onChange={(e) => apply(setToolbarItemShown(layout, item, e.target.checked))} />
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
        title={t("Trennlinie danach einfügen", "Insert divider after")}
        disabled={index >= order.length - 1 || order[index + 1] === TOOLBAR_DIVIDER}
        onClick={() => {
          apply(addToolbarDivider(layout, index));
          setNote(t(`Trennlinie nach „${name}“ eingefügt.`, `Divider inserted after “${name}”.`));
        }}
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

  return (
    <SettingRow
      anchor="toolbar-layout"
      wide
      label={t("Formatierungsleiste anpassen", "Customize formatting toolbar")}
      description={t(
        "Wähle, welche Schaltflächen die Leiste zeigt und in welcher Reihenfolge. Fasse Schaltflächen zu einer Gruppe zusammen – sie erscheint als eine Schaltfläche mit einem kleinen Menü – oder trenne Gruppen mit Trennlinien. Ziehe eine Zeile am Griff oder verschiebe sie mit den Pfeilen. Gilt auf allen Geräten, auch für die Leiste über der Tastatur auf dem Handy.",
        "Choose which buttons the bar shows and in which order. Put buttons together in a group – it shows as one button with a small menu – or separate groups with dividers. Drag a row by its handle or move it with the arrows. Applies on all devices, also to the bar above the keyboard on a phone.",
      )}
    >
      <div className="toolbar-layout">
        <div className="toolbar-layout-actions">
          <button type="button" className="button" aria-expanded={open} aria-controls="toolbar-layout-editor" onClick={() => setOpen(!open)}>
            {open ? t("Fertig", "Done") : t("Anpassen …", "Customize …")}
          </button>
          <button
            type="button"
            className="button"
            disabled={isDefaultToolbarLayout(layout)}
            onClick={() => {
              apply(defaultToolbarLayout(), true);
              setNote(t("Die Leiste zeigt wieder die ursprünglichen Schaltflächen in der ursprünglichen Reihenfolge.", "The bar shows the original buttons in the original order again."));
            }}
          >
            <ArrowCounterClockwise size={16} aria-hidden />
            {t("Zurücksetzen", "Reset")}
          </button>
          <SaveState status={status} />
        </div>
        {open && (
          <div id="toolbar-layout-editor" className="toolbar-layout-editor">
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
                          className="icon-button"
                          aria-label={t("Trennlinie entfernen", "Remove divider")}
                          title={t("Trennlinie entfernen", "Remove divider")}
                          onClick={() => {
                            apply(removeToolbarEntry(layout, index));
                            setNote(t("Trennlinie entfernt.", "Divider removed."));
                          }}
                        >
                          <X size={16} />
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
          </div>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {note}
        </p>
      </div>
    </SettingRow>
  );
}
