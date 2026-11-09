"use client";
// The share dialog's people: who has access to exactly this page, and adding
// someone by e-mail – an existing account right away (as a guest of the
// workspace if they are not a member), anyone else with an invitation.
import { useEffect, useState } from "react";
import type { Role } from "@/lib/types";
import { useT } from "./i18n";
import { Select } from "./select";
import { Hint } from "./share-hint";
import { Avatar, api } from "./ui";

export type Shares = {
  manage: boolean;
  people: { id: string; name: string; email: string; role: "editor" | "viewer"; guest: boolean }[];
  pending: { email: string; role: "editor" | "viewer" }[];
};

export function PagePeople({
  pageId,
  workspaceId,
  me,
  myRole,
  members,
  onChanged,
  onShares,
  onError,
}: {
  pageId: string;
  workspaceId: string;
  // The person looking: listed first, their access as text.
  me: { id: string; name: string; email: string };
  myRole: Role;
  members: { id: string; name: string; email: string }[];
  onChanged: () => void;
  // The loaded list (for the counts in the dialog's summary and tab).
  onShares?: (shares: Shares) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [shares, setSharesState] = useState<Shares | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const setShares = (next: Shares) => {
    setSharesState(next);
    onShares?.(next);
  };
  useEffect(() => {
    let active = true;
    api<Shares>(`/api/pages/${pageId}/shares`)
      .then((r) => {
        if (!active) return;
        setSharesState(r);
        onShares?.(r);
      })
      .catch((e) => onError((e as Error).message));
    return () => {
      active = false;
    };
    // onShares is a state setter of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, onError]);
  const command = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await api<Shares & { status?: "added" | "invited"; name?: string }>("/api/command", { workspaceId, pageId, ...body });
      setShares(result);
      onChanged();
      return result;
    } catch (e) {
      onError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const roleLabel = (value: Role) =>
    value === "owner" ? t("Eigentümer", "Owner") : value === "editor" ? t("Bearbeiten", "Edit") : t("Ansehen", "View||role");
  const roleSelect = (value: string, label: string, onChange: (value: string) => void) => (
    <Select className="sh-role" aria-label={label} value={value} disabled={busy} onChange={(e) => onChange(e.target.value)}>
      <option value="editor">{t("Bearbeiten", "Edit")}</option>
      <option value="viewer">{t("Ansehen", "View||role")}</option>
      <option value="remove">{t("Entfernen", "Remove")}</option>
    </Select>
  );
  const listed = shares?.people.some((p) => p.id === me.id);
  const you = <span className="muted sh-you">{t("(du)", "(you)")}</span>;
  return (
    <div className="page-people">
      <div className="sh-label-row">
        <span id="page-people-title">{t("Personen mit Zugriff", "People with access")}</span>
        <Hint
          text={t(
            "Zusätzlich zu den Rechten des Bereichs. Wer nicht im Arbeitsbereich ist, kommt als Gast dazu und sieht nur, was mit ihm geteilt ist – diese Seite mit ihren Unterseiten.",
            "In addition to the space's permissions. Anyone not in the workspace joins as a guest and sees only what is shared with them – this page with its sub-pages.",
          )}
        />
      </div>
      {shares?.manage && (
        <form
          className="page-people-add"
          onSubmit={async (e) => {
            e.preventDefault();
            const value = email.trim();
            if (!value) return;
            setNote("");
            const result = await command({ action: "page.share", email: value, role });
            if (!result) return;
            setEmail("");
            setNote(
              result.status === "invited"
                ? t(`${value} hat noch kein Konto und bekommt eine Einladung. Die Seite ist da, sobald sich die Person mit dieser Adresse anmeldet.`, `${value} has no account yet and gets an invitation. The page is there as soon as they sign in with this address.`)
                : t(`${result.name} hat jetzt Zugriff.`, `${result.name} has access now.`),
            );
          }}
        >
          <input
            type="email"
            required
            list="page-people-suggestions"
            placeholder={t("E-Mail-Adresse", "E-mail address")}
            aria-label={t("E-Mail-Adresse der Person", "The person's e-mail address")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <datalist id="page-people-suggestions">
            {members.map((m) => (
              <option key={m.id} value={m.email}>
                {m.name}
              </option>
            ))}
          </datalist>
          <Select aria-label={t("Rolle", "Role")} value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")}>
            <option value="viewer">{t("Ansehen", "View||role")}</option>
            <option value="editor">{t("Bearbeiten", "Edit")}</option>
          </Select>
          <button className="button primary" disabled={busy || !email.trim()}>
            {t("Hinzufügen", "Add")}
          </button>
        </form>
      )}
      {note && (
        <p role="status" className="sh-note">
          {note}
        </p>
      )}
      <ul className="sh-list sh-people" aria-labelledby="page-people-title">
        {shares && !listed && (
          <li className="sh-row">
            <Avatar name={me.name} userId={me.id} />
            <span className="sh-who">
              <strong>
                {me.name} {you}
              </strong>
              {me.email && <small>{me.email}</small>}
            </span>
            <span className="sh-role-fixed">{roleLabel(myRole)}</span>
          </li>
        )}
        {shares?.people.map((p) => (
          <li className="sh-row" key={p.id}>
            <Avatar name={p.name} userId={p.id} />
            <span className="sh-who">
              <strong>
                {p.name}
                {p.id === me.id && <> {you}</>}
                {p.guest && <span className="tag">{t("Gast", "Guest")}</span>}
              </strong>
              {p.email && <small>{p.email}</small>}
            </span>
            {shares.manage ? (
              roleSelect(p.role, t(`Seitenrechte für ${p.name}`, `Page permissions for ${p.name}`), (value) => void command({ action: "page.shareUpdate", userId: p.id, role: value }))
            ) : (
              <span className="sh-role-fixed">{roleLabel(p.role)}</span>
            )}
          </li>
        ))}
        {shares?.pending.map((p) => (
          <li className="sh-row" key={p.email}>
            <Avatar name={p.email} userId={null} />
            <span className="sh-who">
              <strong>{p.email}</strong>
              <small>{t("Eingeladen, noch kein Konto", "Invited, no account yet")}</small>
            </span>
            {roleSelect(p.role, t(`Seitenrechte für ${p.email}`, `Page permissions for ${p.email}`), (value) => void command({ action: "page.shareUpdate", email: p.email, role: value }))}
          </li>
        ))}
      </ul>
      {shares && !shares.people.length && !shares.pending.length && (
        <p className="sh-empty">{t("Noch niemand eigens hinzugefügt.", "Nobody added specifically yet.")}</p>
      )}
      {shares && !shares.manage && (
        <p className="sh-note">
          {t("Personen hinzufügen können Eigentümer des Arbeitsbereichs und des Bereichs.", "Owners of the workspace and of the space can add people.")}
        </p>
      )}
    </div>
  );
}
