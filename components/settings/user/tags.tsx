"use client";
// Settings → Arbeitsbereich → Tags & Eigenschaften (issue #70): the
// workspace's tags (rename, colour, order, merge, delete) and the property
// definitions of pages (add, edit, order, delete). Each belongs to the whole
// workspace or to one space (#136): a filter by scope, a badge, and – for
// owners – "Geltungsbereich ändern" with where it is used. Workspace owners
// change everything, space owners their space's; everybody else sees the
// lists.
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ArrowsLeftRight, PencilSimple, Plus, Tag as TagIcon, Trash } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { Select } from "../../select";
import { Modal, api } from "../../ui";
import { EmptyState, SettingGroup } from "../../settings-ui";
import { PropertyDialog, TagChip, TYPE_ICONS, typeLabel } from "../../page-properties";
import { ScopeBadge } from "../../meta-scope";
import { PAGE_TAG_COLORS, type PagePropertyDef, type PageTag, type PageTagColor } from "@/lib/page-properties";
import { useUserSettings } from "../user-context";

type ScopeTarget = { kind: "tag" | "property"; item: PageTag | PagePropertyDef };
type Usage = { spaceId: string; spaceName: string; pages: number; records: number; titles: string[] };

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
  const manageSpaces = taxonomy?.manageSpaces ?? [];
  const spaces = boot.spaces.filter((sp) => !sp.deleted_at);
  // What a person manages: everything (owners) or their spaces' own ones.
  const mayManage = (item: { spaceId?: string | null }) => manage || (!!item.spaceId && manageSpaces.includes(item.spaceId));
  // Scopes one may create in: the workspace (owners), spaces one manages.
  const creatable = spaces.filter((sp) => manage || manageSpaces.includes(sp.id));
  const [scope, setScope] = useState("all"),
    [newScope, setNewScope] = useState<string>(manage ? "" : (manageSpaces[0] ?? ""));
  const inFilter = (item: { spaceId?: string | null }) => scope === "all" || (scope === "workspace" ? !item.spaceId : item.spaceId === scope);
  const allTags = taxonomy?.tags ?? [];
  const tags = allTags.filter(inFilter),
    properties = (taxonomy?.properties ?? []).filter(inFilter);
  const [busy, setBusy] = useState(false),
    [newTag, setNewTag] = useState(""),
    [editing, setEditing] = useState<PagePropertyDef | "new" | null>(null),
    [rescoping, setRescoping] = useState<ScopeTarget | null>(null);
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
      {spaces.length > 0 && (
        <div className="tag-settings-scope">
          <Select aria-label={t("Nach Geltungsbereich filtern", "Filter by scope")} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">{t("Alle Geltungsbereiche", "All scopes")}</option>
            <option value="workspace">{t("Ganzer Arbeitsbereich", "Whole workspace")}</option>
            {spaces.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {t(`Bereich „${sp.name}“`, `Space “${sp.name}”`)}
              </option>
            ))}
          </Select>
        </div>
      )}
      <SettingGroup
        id="tags"
        title={t(`Tags · ${tags.length}`, `Tags · ${tags.length}`)}
        description={
          manage || manageSpaces.length
            ? t(
                "Ein Tag gilt im ganzen Arbeitsbereich oder nur in einem Bereich; neue Tags unter dem Seitentitel gehören zum Bereich der Seite. Mitglieder mit Bearbeitungsrechten vergeben Tags und legen dabei neue an; umbenennen, einfärben, zusammenführen und löschen können Eigentümer – die eines Bereichs dessen eigene Tags.",
                "A tag applies in the whole workspace or only in one space; new tags under a page title belong to the page's space. Members with edit rights add tags and create new ones there; owners rename, colour, merge and delete them – a space's owners its own tags.",
              )
            : t(
                "Ein Tag gilt im ganzen Arbeitsbereich oder nur in einem Bereich. Verwalten können sie die Eigentümer des Arbeitsbereichs und der Bereiche.",
                "A tag applies in the whole workspace or only in one space. The owners of the workspace and of the spaces manage them.",
              )
        }
      >
        {(manage || creatable.length > 0) && (
          <form
            className="tag-settings-add"
            onSubmit={async (e) => {
              e.preventDefault();
              if (newTag.trim() && (await run({ action: "tag.save", name: newTag, spaceId: newScope || null }))) setNewTag("");
            }}
          >
            <input value={newTag} maxLength={60} onChange={(e) => setNewTag(e.target.value)} placeholder={t("Neuer Tag", "New tag")} aria-label={t("Neuer Tag", "New tag")} />
            <Select aria-label={t("Geltungsbereich des neuen Tags", "Scope of the new tag")} value={newScope} onChange={(e) => setNewScope(e.target.value)}>
              {manage && <option value="">{t("Im ganzen Arbeitsbereich", "In the whole workspace")}</option>}
              {creatable.map((sp) => (
                <option key={sp.id} value={sp.id}>
                  {t(`Nur in „${sp.name}“`, `Only in “${sp.name}”`)}
                </option>
              ))}
            </Select>
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
                // Merging only into a tag every page of this one may carry.
                tags={allTags.filter((x) => !x.spaceId || x.spaceId === tag.spaceId)}
                count={counts.get(tag.id) || 0}
                manage={mayManage(tag)}
                busy={busy}
                first={i === 0}
                last={i === tags.length - 1}
                run={run}
                onMove={(delta) => move(tags, i, delta, "tag.reorder")}
                spaces={spaces}
                onRescope={manage ? () => setRescoping({ kind: "tag", item: tag }) : undefined}
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
          "Eigenschaften wie Status, Kunde oder Fälligkeit gelten für alle Seiten des Arbeitsbereichs oder nur für die eines Bereichs; jede dieser Seiten kann einen Wert dafür haben. In der Suche findet „Name:Wert“ die Seiten mit diesem Wert.",
          "Properties like status, customer or due date apply to all pages of the workspace or only to those of one space; each of these pages can have a value for them. In the search, “name:value” finds the pages with that value.",
        )}
        actions={
          manage || creatable.length ? (
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
                    <strong className="ws-break">
                      {def.name} <ScopeBadge spaceId={def.spaceId} spaces={spaces} />
                    </strong>
                    <span className="muted">
                      {typeLabel(def.type, t)}
                      {def.options.length ? ` · ${def.options.join(", ")}` : ""}
                    </span>
                  </div>
                  {mayManage(def) && (
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
                      {manage && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={t(`Geltungsbereich von ${def.name} ändern`, `Change the scope of ${def.name}`)}
                          title={t("Geltungsbereich ändern", "Change scope")}
                          onClick={() => setRescoping({ kind: "property", item: def })}
                        >
                          <ArrowsLeftRight size={16} />
                        </button>
                      )}
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
              : t("Die Eigentümer des Arbeitsbereichs und der Bereiche legen sie an.", "The owners of the workspace and of the spaces create them.")}
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
          spaces={creatable}
          scope={{ spaceId: null, space: false, workspace: manage }}
        />
      )}
      {rescoping && (
        <ScopeDialog
          target={rescoping}
          workspaceId={boot.workspace.id}
          spaces={spaces}
          busy={busy}
          run={run}
          onClose={() => setRescoping(null)}
        />
      )}
    </>
  );
}

// "Geltungsbereich ändern" (owners): to the whole workspace or one space. It
// shows where the tag or property is used outside the target and what
// happens there – refused, copied for those spaces, or removed there – and
// same-named ones it would meet (merged only on request).
function ScopeDialog({
  target,
  workspaceId,
  spaces,
  busy,
  run,
  onClose,
}: {
  target: ScopeTarget;
  workspaceId: string;
  spaces: { id: string; name: string }[];
  busy: boolean;
  run: (b: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const { kind, item } = target;
  const [to, setTo] = useState<string>(item.spaceId ? "" : (spaces[0]?.id ?? "")),
    [resolve, setResolve] = useState<"block" | "copy" | "remove">("copy"),
    [merge, setMerge] = useState(false),
    [check, setCheck] = useState<{ to: string; usage: Usage[]; clashes: { id: string; spaceName: string }[] } | null>(null);
  const toSpace = to || null;
  const unchanged = (item.spaceId ?? null) === toSpace;
  const current = check && check.to === to ? check : null;
  // Where it is used outside the chosen target (nothing changes yet).
  useEffect(() => {
    if (unchanged) return;
    let live = true;
    void api<{ usage: Usage[]; clashes: { id: string; spaceName: string }[] }>("/api/command", { action: "meta.usage", workspaceId, kind, id: item.id, spaceId: toSpace })
      .then((r) => live && setCheck({ to, ...r }))
      .catch(() => live && setCheck({ to, usage: [], clashes: [] }));
    return () => {
      live = false;
    };
  }, [unchanged, workspaceId, kind, item.id, toSpace, to]);
  const where = (n: Usage) =>
    [
      n.pages ? (n.pages === 1 ? t("1 Seite", "1 page") : t(`${n.pages} Seiten`, `${n.pages} pages`)) : "",
      n.records ? (n.records === 1 ? t("1 Eintrag", "1 record") : t(`${n.records} Einträge`, `${n.records} records`)) : "",
    ]
      .filter(Boolean)
      .join(", ");
  return (
    <Modal open sheet onClose={() => !busy && onClose()} title={t(`Geltungsbereich von „${item.name}“`, `Scope of “${item.name}”`)}>
      <form
        className="scope-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await run({
            action: kind === "tag" ? "tag.scope" : "property.scope",
            [kind === "tag" ? "tagId" : "propertyId"]: item.id,
            spaceId: toSpace,
            resolve,
            mergeSameName: merge,
          });
          if (result) onClose();
        }}
      >
        <p className="muted">
          {t("Jetzt:", "Now:")} <ScopeBadge spaceId={item.spaceId} spaces={spaces} />
        </p>
        <label>
          {t("Gilt künftig", "Applies from now on")}
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t("Im ganzen Arbeitsbereich", "In the whole workspace")}</option>
            {spaces.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {t(`Nur im Bereich „${sp.name}“`, `Only in the space “${sp.name}”`)}
              </option>
            ))}
          </Select>
        </label>
        {!unchanged && !current && <p className="muted">{t("Wird geprüft …", "Checking …")}</p>}
        {current && current.usage.length > 0 && (
          <div className="scope-usage">
            <p>{t("Außerhalb des Zielbereichs verwendet:", "Used outside the target space:")}</p>
            <ul>
              {current.usage.map((u) => (
                <li key={u.spaceId}>
                  <strong>{u.spaceName}</strong>: {where(u)}
                  {u.titles.length > 0 && <small className="muted"> – {u.titles.join(", ")}</small>}
                </li>
              ))}
            </ul>
            <fieldset>
              <legend>{t("Was geschieht dort?", "What happens there?")}</legend>
              <label className="checkbox-label">
                <input type="radio" name="resolve" checked={resolve === "copy"} onChange={() => setResolve("copy")} />
                {t("Für die anderen Bereiche kopieren (gleicher Name, je Bereich eigen)", "Copy for the other spaces (same name, one per space)")}
              </label>
              <label className="checkbox-label">
                <input type="radio" name="resolve" checked={resolve === "remove"} onChange={() => setResolve("remove")} />
                {kind === "tag" ? t("Dort entfernen", "Remove there") : t("Dort entfernen (die Werte gehen verloren)", "Remove there (the values are lost)")}
              </label>
              <label className="checkbox-label">
                <input type="radio" name="resolve" checked={resolve === "block"} onChange={() => setResolve("block")} />
                {t("Nicht ändern, solange es dort verwendet wird", "Do not change while it is used there")}
              </label>
            </fieldset>
          </div>
        )}
        {current && current.clashes.length > 0 && (
          <label className="checkbox-label">
            <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
            {t(
              `Gleichnamige zusammenführen (${current.clashes.map((c) => c.spaceName || t("Arbeitsbereich", "Workspace")).join(", ")})`,
              `Merge same-named (${current.clashes.map((c) => c.spaceName || t("Arbeitsbereich", "Workspace")).join(", ")})`,
            )}
          </label>
        )}
        {current && !current.usage.length && !current.clashes.length && (
          <p className="muted">{t("Nirgends sonst verwendet – nichts geht verloren.", "Not used anywhere else – nothing is lost.")}</p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || unchanged || !current || (current.clashes.length > 0 && !merge)}>
            {t("Ändern", "Change")}
          </button>
        </div>
      </form>
    </Modal>
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
  spaces,
  onRescope,
}: {
  spaces: { id: string; name: string }[];
  onRescope?: () => void;
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
        <ScopeBadge spaceId={tag.spaceId} spaces={spaces} />
        <span className="muted">{pages}</span>
      </li>
    );
  return (
    <li className="ws-item ws-item-inline tag-settings-row">
      <TagChip tag={{ name: name || tag.name, color: tag.color }} />
      <ScopeBadge spaceId={tag.spaceId} spaces={spaces} />
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
        {onRescope && (
          <button
            type="button"
            className="icon-button"
            aria-label={t(`Geltungsbereich von ${tag.name} ändern`, `Change the scope of ${tag.name}`)}
            title={t("Geltungsbereich ändern", "Change scope")}
            disabled={busy}
            onClick={onRescope}
          >
            <ArrowsLeftRight size={16} />
          </button>
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
