"use client";
// Directory groups by hand (#451, lib/directory-groups.ts): the
// "Verzeichnisgruppen" of a person's details (Administration → Benutzer) –
// their groups with the source, "Zu Gruppe hinzufügen" and "Entfernen" –
// and the "Mitglieder" dialog of a directory group (Grenzen pro Gruppe, KI
// → Kontingente). The server decides where a membership is stored and
// what may be removed; this shows it. A membership from LDAP or the SSO
// sign-in is read-only here: the next sync or sign-in would bring it back.
import { useCallback, useEffect, useId, useState } from "react";
import { MagnifyingGlass, Plus, Trash, Users } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { Avatar, Modal, showNotice } from "../../ui";
import { StatusBadge } from "../../settings-ui";
import { useAdmin } from "../admin-context";
import { MAX_DIRECTORY_NAME } from "@/lib/group-keys";
import type { DirectoryGroupInfo, DirectoryMembership } from "@/lib/directory-groups";
import type { User } from "@/lib/types";

type T = (de: string, en: string) => string;
type PersonView = { groups: DirectoryMembership[]; names: string[]; existing: string[] };

// The badges of a membership: SCIM, LDAP, SSO, by hand.
function Sources({ m }: { m: Pick<DirectoryMembership, "sources" | "byHand"> }) {
  const t = useT();
  return (
    <span className="dir-group-sources">
      {m.sources.map((s) => (
        <StatusBadge key={s} tone="info">
          {s.toUpperCase()}
        </StatusBadge>
      ))}
      {m.byHand && <StatusBadge tone="off">{t("von Hand", "by hand")}</StatusBadge>}
    </span>
  );
}

// Why a membership cannot be removed here, or what remains after removing.
const fixedHint = (m: Pick<DirectoryMembership, "fixed" | "removable">, t: T) => {
  if (!m.fixed.length) return null;
  const from = m.fixed.map((f) => f.toUpperCase()).join("/");
  return m.removable
    ? t(`Bleibt Mitglied über ${from} – dort ändern.`, `Stays a member through ${from} – change it there.`)
    : t(`Kommt aus ${from} – dort ändern.`, `Comes from ${from} – change it there.`);
};

// "Verzeichnisgruppen" of one person (the details panel).
export function PersonDirectoryGroups({ user }: { user: Pick<User, "id" | "name"> }) {
  const t = useT();
  const { mutate, load, onError } = useAdmin();
  const [view, setView] = useState<PersonView | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId(),
    listId = useId(),
    hintId = useId();
  const refresh = useCallback(async () => {
    try {
      setView((await mutate({ action: "admin.directoryGroups", userId: user.id })) as PersonView);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [mutate, onError, user.id]);
  useEffect(() => void refresh(), [refresh]);
  // A change, then this list and the administration's data (the person's limits).
  const change = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await mutate(body);
      showNotice(done);
      await refresh();
      await load();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const trimmed = name.trim();
  const has = !!view?.groups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase() && g.removable);
  const add = async () => {
    if (!trimmed || has || busy) return;
    if (await change({ action: "admin.directoryGroupAdd", userId: user.id, name: trimmed }, t(`${user.name} ist jetzt in „${trimmed}“.`, `${user.name} is now in “${trimmed}”.`))) setName("");
  };
  // Without a SCIM group or members of that name, the server creates a SCIM group.
  const known = view?.existing.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  return (
    <section className="ux-block dir-groups" aria-label={t("Verzeichnisgruppen", "Directory groups")}>
      <h3 className="dir-groups-head">
        {t("Verzeichnisgruppen", "Directory groups")}
        {view && <strong>{view.groups.length}</strong>}
      </h3>
      {!view ? (
        <p className="ux-more-note muted">{t("Lädt …", "Loading …")}</p>
      ) : view.groups.length === 0 ? (
        <p className="ux-more-note muted">{t("In keiner Verzeichnisgruppe (SCIM, LDAP, SSO).", "In no directory group (SCIM, LDAP, SSO).")}</p>
      ) : (
        <ul className="dir-group-list">
          {view.groups.map((g) => (
            <li key={g.name} className="dir-group-item">
              <span className="dir-group-text">
                <strong>{g.name}</strong>
                <Sources m={g} />
                {fixedHint(g, t) && <small className="limit-source">{fixedHint(g, t)}</small>}
              </span>
              {g.removable && (
                <button
                  type="button"
                  className="button compact"
                  disabled={busy}
                  aria-label={t(`${user.name} aus „${g.name}“ entfernen`, `Remove ${user.name} from “${g.name}”`)}
                  onClick={() => void change({ action: "admin.directoryGroupRemove", userId: user.id, name: g.name }, t(`${user.name} ist nicht mehr in „${g.name}“.`, `${user.name} is no longer in “${g.name}”.`))}
                >
                  <Trash size={15} aria-hidden /> {t("Entfernen", "Remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <label className="dir-group-add-label" htmlFor={inputId}>
        {t("Zu Gruppe hinzufügen", "Add to group")}
      </label>
      <span className="dir-group-add">
        <input
          id={inputId}
          className="control-md"
          list={listId}
          maxLength={MAX_DIRECTORY_NAME}
          autoComplete="off"
          aria-describedby={hintId}
          placeholder={t("Gruppe suchen oder neuer Name", "Search a group or a new name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <datalist id={listId}>
          {(view?.names || [])
            .filter((n) => !view?.groups.some((g) => g.name === n && g.removable))
            .map((n) => (
              <option key={n} value={n} />
            ))}
        </datalist>
        <button type="button" className="button compact" disabled={!trimmed || has || busy} onClick={() => void add()}>
          <Plus size={15} aria-hidden /> {t("Hinzufügen", "Add")}
        </button>
      </span>
      <small id={hintId} className="limit-source">
        {trimmed && !known
          ? t(`„${trimmed}“ gibt es noch nicht: wird als SCIM-Gruppe angelegt, die SCIM-Clients (z. B. die Abrechnung) ebenso sehen.`, `“${trimmed}” does not exist yet: created as a SCIM group that SCIM clients (e.g. billing) see as well.`)
          : t(
              "SCIM-Gruppen behalten von Hand hinzugefügte Mitglieder (die Abrechnung meldet sie nur). Bei LDAP- und SSO-Gruppen gilt die Mitgliedschaft von Hand zusätzlich und übersteht Abgleich und Anmeldung.",
              "SCIM groups keep members added by hand (billing only reports them). For LDAP and SSO groups the membership by hand applies in addition and survives syncs and sign-ins.",
            )}
      </small>
    </section>
  );
}

// "Mitglieder": a button that opens the members dialog of a directory group.
export function DirectoryMembersButton({ name, label }: { name: string; label: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button compact dir-members-button" aria-label={t(`Mitglieder von ${label}`, `Members of ${label}`)} onClick={() => setOpen(true)}>
        <Users size={15} aria-hidden /> {t("Mitglieder", "Members")}
      </button>
      {open && <DirectoryMembersDialog name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

export function DirectoryMembersDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const t = useT();
  const { data, ensure, mutate, load, onError } = useAdmin();
  const [info, setInfo] = useState<DirectoryGroupInfo | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // The people to choose from come with the administration's data.
  useEffect(() => {
    if (!data) ensure();
  }, [data, ensure]);
  const refresh = useCallback(async () => {
    try {
      setInfo((await mutate({ action: "admin.directoryGroupMembers", name })) as DirectoryGroupInfo);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [mutate, onError, name]);
  useEffect(() => void refresh(), [refresh]);
  const change = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await mutate(body);
      showNotice(done);
      await refresh();
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const groupName = info?.name ?? name;
  const inGroup = new Set((info?.members || []).filter((m) => m.removable).map((m) => m.userId));
  const needle = query.trim().toLocaleLowerCase();
  const candidates = needle
    ? (data?.users || []).filter((u) => !inGroup.has(u.id) && `${u.name} ${u.email}`.toLocaleLowerCase().includes(needle)).slice(0, 8)
    : [];
  return (
    <Modal open onClose={() => !busy && onClose()} title={t(`Mitglieder von „${groupName}“`, `Members of “${groupName}”`)} className="dir-members-dialog" wide sheet>
      <p className="muted dir-members-note">
        {info?.scim
          ? t("SCIM-Gruppe: SCIM-Clients sehen von Hand hinzugefügte Mitglieder, die sie selbst angelegt haben; die Abrechnung meldet sie nur, sie entfernt sie nicht.", "SCIM group: SCIM clients see members added by hand that they provisioned themselves; billing only reports them, it does not remove them.")
          : t("Mitglieder aus LDAP oder der SSO-Anmeldung ändern sich dort; von Hand hinzugefügte gelten zusätzlich und überstehen Abgleich und Anmeldung.", "Members from LDAP or the SSO sign-in change there; members added by hand apply in addition and survive syncs and sign-ins.")}
      </p>
      {!info ? (
        <p className="muted">{t("Lädt …", "Loading …")}</p>
      ) : info.members.length === 0 ? (
        <p className="muted">{t("Noch keine Mitglieder.", "No members yet.")}</p>
      ) : (
        <ul className="dir-group-list" aria-label={t("Mitglieder", "Members")}>
          {info.members.map((m) => (
            <li key={m.userId} className="dir-group-item">
              <Avatar name={m.userName} userId={m.userId} />
              <span className="dir-group-text">
                <strong>{m.userName}</strong>
                {m.email && <small className="muted">{m.email}</small>}
                <Sources m={m} />
                {fixedHint(m, t) && <small className="limit-source">{fixedHint(m, t)}</small>}
              </span>
              {m.removable && (
                <button
                  type="button"
                  className="button compact"
                  disabled={busy}
                  aria-label={t(`${m.userName} entfernen`, `Remove ${m.userName}`)}
                  onClick={() => void change({ action: "admin.directoryGroupRemove", userId: m.userId, name: groupName }, t(`${m.userName} ist nicht mehr in „${groupName}“.`, `${m.userName} is no longer in “${groupName}”.`))}
                >
                  <Trash size={15} aria-hidden /> {t("Entfernen", "Remove")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3 className="mon-subhead">{t("Person hinzufügen", "Add a person")}</h3>
      <span className="admin-search dir-members-search">
        <MagnifyingGlass size={16} aria-hidden />
        <input type="search" aria-label={t("Person suchen", "Search a person")} placeholder={t("Name oder E-Mail suchen …", "Search name or email …")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </span>
      {needle && candidates.length === 0 && <p className="muted">{t("Niemand gefunden.", "Nobody found.")}</p>}
      <ul className="merge-candidates">
        {candidates.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              className="merge-candidate"
              disabled={busy}
              onClick={() => void change({ action: "admin.directoryGroupAdd", userId: u.id, name: groupName }, t(`${u.name} ist jetzt in „${groupName}“.`, `${u.name} is now in “${groupName}”.`)).then(() => setQuery(""))}
            >
              <Avatar name={u.name} userId={u.id} />
              <span className="merge-candidate-text">
                <strong>{u.name}</strong>
                <small>{u.email}</small>
              </span>
              <Plus size={15} aria-label={t("Hinzufügen", "Add")} />
            </button>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          {t("Schließen", "Close")}
        </button>
      </div>
    </Modal>
  );
}
