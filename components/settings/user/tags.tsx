"use client";
// Settings → Arbeitsbereich → Tags & Eigenschaften (issue #70): the
// workspace's tags (rename, colour, order, merge, delete) and the property
// definitions of pages (add, edit, order, delete). Workspace owners change
// them; everybody else sees the lists.
import { useState } from "react";
import { ArrowDown, ArrowUp, PencilSimple, Plus, Tag as TagIcon, Trash } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { Select } from "../../select";
import { EmptyState, SettingGroup } from "../../settings-ui";
import { PropertyDialog, TagChip, TYPE_ICONS, typeLabel } from "../../page-properties";
import { PAGE_TAG_COLORS, type PagePropertyDef, type PageTag, type PageTagColor } from "@/lib/page-properties";
import { useUserSettings } from "../user-context";

export function colorLabel(color: PageTagColor, t: (de: string, en: string) => string) {
  const labels: Record<PageTagColor, string> = {
    gray: t("Grau", "Gray"),
    blue: t("Blau", "Blue"),
    green: t("Grün", "Green"),
    red: t("Rot", "Red"),
    yellow: t("Gelb", "Yellow"),
    orange: t("Orange", "Orange"),
    purple: t("Lila", "Purple"),
    pink: t("Rosa", "Pink"),
    teal: t("Türkis", "Teal"),
  };
  return labels[color];
}

export default function TagsSection() {
  const t = useT();
  const { boot, mutate, onError, onRefresh } = useUserSettings();
  const taxonomy = boot.taxonomy;
  const manage = !!taxonomy?.manage;
  const tags = taxonomy?.tags ?? [],
    properties = taxonomy?.properties ?? [];
  const [busy, setBusy] = useState(false),
    [newTag, setNewTag] = useState(""),
    [editing, setEditing] = useState<PagePropertyDef | "new" | null>(null);
  const counts = new Map<string, number>();
  for (const ids of Object.values(taxonomy?.links ?? {})) for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const run = async (b: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await mutate({ workspaceId: boot.workspace.id, ...b });
      await onRefresh();
      return result;
    } catch (e) {
      onError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const move = (list: { id: string }[], index: number, delta: -1 | 1, action: string) => {
    const order = list.map((x) => x.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    void run({ action, order });
  };
  return (
    <>
      <SettingGroup
        id="tags"
        title={t(`Tags · ${tags.length}`, `Tags · ${tags.length}`)}
        description={
          manage
            ? t(
                "Tags gelten für den ganzen Arbeitsbereich. Mitglieder mit Bearbeitungsrechten vergeben sie unter dem Seitentitel und legen dabei neue an; umbenennen, einfärben, zusammenführen und löschen können Eigentümer.",
                "Tags apply to the whole workspace. Members with edit rights add them under the page title and create new ones there; owners rename, colour, merge and delete them.",
              )
            : t("Tags gelten für den ganzen Arbeitsbereich. Verwalten können sie die Eigentümer des Arbeitsbereichs.", "Tags apply to the whole workspace. The workspace owners manage them.")
        }
      >
        {manage && (
          <form
            className="tag-settings-add"
            onSubmit={async (e) => {
              e.preventDefault();
              if (newTag.trim() && (await run({ action: "tag.save", name: newTag }))) setNewTag("");
            }}
          >
            <input value={newTag} maxLength={60} onChange={(e) => setNewTag(e.target.value)} placeholder={t("Neuer Tag", "New tag")} aria-label={t("Neuer Tag", "New tag")} />
            <button className="button compact" disabled={busy || !newTag.trim()}>
              <Plus size={14} aria-hidden /> {t("Hinzufügen", "Add")}
            </button>
          </form>
        )}
        {tags.length ? (
          <ul className="ws-list tag-settings-list" aria-label={t("Tags", "Tags")}>
            {tags.map((tag, i) => (
              <TagRow
                key={tag.id}
                tag={tag}
                tags={tags}
                count={counts.get(tag.id) || 0}
                manage={manage}
                busy={busy}
                first={i === 0}
                last={i === tags.length - 1}
                run={run}
                onMove={(delta) => move(tags, i, delta, "tag.reorder")}
              />
            ))}
          </ul>
        ) : (
          <EmptyState icon={<TagIcon size={28} />} title={t("Noch keine Tags", "No tags yet")}>
            {t("Unter dem Titel einer Seite fügst du mit „+ Tag“ einen hinzu.", "Add one under a page's title with “+ Tag”.")}
          </EmptyState>
        )}
      </SettingGroup>
      <SettingGroup
        id="properties"
        title={t(`Seiteneigenschaften · ${properties.length}`, `Page properties · ${properties.length}`)}
        description={t(
          "Eigenschaften wie Status, Kunde oder Fälligkeit gelten für alle Seiten des Arbeitsbereichs; jede Seite kann einen Wert dafür haben. In der Suche findet „Name:Wert“ die Seiten mit diesem Wert.",
          "Properties like status, customer or due date apply to all pages of the workspace; every page can have a value for them. In the search, “name:value” finds the pages with that value.",
        )}
        actions={
          manage ? (
            <button type="button" className="button compact" onClick={() => setEditing("new")}>
              <Plus size={14} aria-hidden /> {t("Eigenschaft", "Property")}
            </button>
          ) : undefined
        }
      >
        {properties.length ? (
          <ul className="ws-list" aria-label={t("Seiteneigenschaften", "Page properties")}>
            {properties.map((def, i) => {
              const TypeIcon = TYPE_ICONS[def.type];
              return (
                <li className="ws-item ws-item-inline" key={def.id}>
                  <span className="ws-item-icon" aria-hidden>
                    <TypeIcon size={18} />
                  </span>
                  <div className="ws-item-text">
                    <strong className="ws-break">{def.name}</strong>
                    <span className="muted">
                      {typeLabel(def.type, t)}
                      {def.options.length ? ` · ${def.options.join(", ")}` : ""}
                    </span>
                  </div>
                  {manage && (
                    <div className="ws-item-controls">
                      <span className="ws-order-buttons">
                        <button type="button" className="icon-button" aria-label={t(`${def.name} nach oben`, `Move ${def.name} up`)} disabled={busy || i === 0} onClick={() => move(properties, i, -1, "property.reorder")}>
                          <ArrowUp size={16} />
                        </button>
                        <button type="button" className="icon-button" aria-label={t(`${def.name} nach unten`, `Move ${def.name} down`)} disabled={busy || i === properties.length - 1} onClick={() => move(properties, i, 1, "property.reorder")}>
                          <ArrowDown size={16} />
                        </button>
                      </span>
                      <button type="button" className="icon-button" aria-label={t(`${def.name} bearbeiten`, `Edit ${def.name}`)} onClick={() => setEditing(def)}>
                        <PencilSimple size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t(`${def.name} löschen`, `Delete ${def.name}`)}
                        disabled={busy}
                        onClick={() => {
                          if (confirm(t(`Eigenschaft „${def.name}“ mit allen Werten löschen?`, `Delete the property “${def.name}” with all its values?`)))
                            void run({ action: "property.delete", propertyId: def.id });
                        }}
                      >
                        <Trash size={16} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title={t("Noch keine Eigenschaften", "No properties yet")}>
            {manage
              ? t("Lege eine an, z. B. „Status“ als Auswahl oder „Kunde“ als Text.", "Add one, e.g. “Status” as a select or “Customer” as text.")
              : t("Die Eigentümer des Arbeitsbereichs legen sie an.", "The workspace owners create them.")}
          </EmptyState>
        )}
      </SettingGroup>
      {editing && (
        <PropertyDialog
          workspaceId={boot.workspace.id}
          def={editing === "new" ? undefined : editing}
          act={async (b) => {
            const result = await run(b);
            return result;
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function TagRow({
  tag,
  tags,
  count,
  manage,
  busy,
  first,
  last,
  run,
  onMove,
}: {
  tag: PageTag;
  tags: PageTag[];
  count: number;
  manage: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  run: (b: Record<string, unknown>) => Promise<unknown>;
  onMove: (delta: -1 | 1) => void;
}) {
  const t = useT();
  const [name, setName] = useState(tag.name);
  const pages = count === 1 ? t("1 Seite", "1 page") : t(`${count} Seiten`, `${count} pages`);
  if (!manage)
    return (
      <li className="ws-item ws-item-inline">
        <TagChip tag={tag} onOpen={() => (location.hash = `tags/${tag.id}`)} />
        <span className="muted">{pages}</span>
      </li>
    );
  return (
    <li className="ws-item ws-item-inline tag-settings-row">
      <TagChip tag={{ name: name || tag.name, color: tag.color }} />
      <input
        className="tag-settings-name"
        value={name}
        maxLength={60}
        aria-label={t(`Name von ${tag.name}`, `Name of ${tag.name}`)}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() && name.trim() !== tag.name) void run({ action: "tag.save", tagId: tag.id, name });
          else setName(tag.name);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <Select aria-label={t(`Farbe von ${tag.name}`, `Colour of ${tag.name}`)} value={tag.color} disabled={busy} onChange={(e) => void run({ action: "tag.save", tagId: tag.id, name: tag.name, color: e.target.value })}>
        {PAGE_TAG_COLORS.map((color) => (
          <option key={color} value={color}>
            {colorLabel(color, t)}
          </option>
        ))}
      </Select>
      <a className="text-button tag-settings-count" href={`#tags/${tag.id}`}>
        {pages}
      </a>
      <div className="ws-item-controls">
        <span className="ws-order-buttons">
          <button type="button" className="icon-button" aria-label={t(`${tag.name} nach oben`, `Move ${tag.name} up`)} disabled={busy || first} onClick={() => onMove(-1)}>
            <ArrowUp size={16} />
          </button>
          <button type="button" className="icon-button" aria-label={t(`${tag.name} nach unten`, `Move ${tag.name} down`)} disabled={busy || last} onClick={() => onMove(1)}>
            <ArrowDown size={16} />
          </button>
        </span>
        {tags.length > 1 && (
          <Select
            aria-label={t(`${tag.name} zusammenführen mit`, `Merge ${tag.name} into`)}
            value=""
            disabled={busy}
            onChange={(e) => {
              const into = tags.find((x) => x.id === e.target.value);
              if (into && confirm(t(`„${tag.name}“ mit „${into.name}“ zusammenführen? Alle Seiten bekommen „${into.name}“, „${tag.name}“ wird gelöscht.`, `Merge “${tag.name}” into “${into.name}”? All its pages get “${into.name}”, “${tag.name}” is deleted.`)))
                void run({ action: "tag.merge", tagId: tag.id, into: into.id });
            }}
          >
            <option value="">{t("Zusammenführen …", "Merge …")}</option>
            {tags
              .filter((x) => x.id !== tag.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </Select>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={t(`${tag.name} löschen`, `Delete ${tag.name}`)}
          disabled={busy}
          onClick={() => {
            if (confirm(t(`Tag „${tag.name}“ löschen? Er verschwindet von ${pages}.`, `Delete the tag “${tag.name}”? It is removed from ${pages}.`)))
              void run({ action: "tag.delete", tagId: tag.id });
          }}
        >
          <Trash size={16} />
        </button>
      </div>
    </li>
  );
}
