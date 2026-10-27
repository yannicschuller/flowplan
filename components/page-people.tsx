"use client";
// The share dialog's people: who has access to exactly this page, and adding
// someone by e-mail – an existing account right away (as a guest of the
// workspace if they are not a member), anyone else with an invitation.
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { Select } from "./select";
import { Avatar, api } from "./ui";

type Shares = {
  manage: boolean;
  people: { id: string; name: string; email: string; role: "editor" | "viewer"; guest: boolean }[];
  pending: { email: string; role: "editor" | "viewer" }[];
};

export function PagePeople({
  pageId,
  workspaceId,
  members,
  onChanged,
  onError,
}: {
  pageId: string;
  workspaceId: string;
  members: { id: string; name: string; email: string }[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [shares, setShares] = useState<Shares | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let active = true;
    api<Shares>(`/api/pages/${pageId}/shares`)
      .then((r) => active && setShares(r))
      .catch((e) => onError((e as Error).message));
    return () => {
      active = false;
    };
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
  const roleSelect = (value: string, label: string, onChange: (value: string) => void) => (
    <Select aria-label={label} value={value} disabled={busy} onChange={(e) => onChange(e.target.value)}>
      <option value="editor">{t("Bearbeiten", "Edit")}</option>
      <option value="viewer">{t("Ansehen", "View||role")}</option>
      <option value="remove">{t("Entfernen", "Remove")}</option>
    </Select>
  );
  return (
    <div className="share-members page-people">
      <h3>{t("Personen mit Zugriff auf diese Seite", "People with access to this page")}</h3>
      <p className="muted">
        {t(
          "Zusätzlich zu den Rechten des Bereichs. Wer nicht im Arbeitsbereich ist, kommt als Gast dazu und sieht nur, was mit ihm geteilt ist – diese Seite mit ihren Unterseiten.",
          "In addition to the space's permissions. Anyone not in the workspace joins as a guest and sees only what is shared with them – this page with its sub-pages.",
        )}
      </p>
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
        <p role="status" className="muted small">
          {note}
        </p>
      )}
      {shares && !shares.people.length && !shares.pending.length && (
        <p className="muted small">{t("Noch niemand eigens hinzugefügt.", "Nobody added specifically yet.")}</p>
      )}
      {shares?.people.map((p) => (
        <div className="member-row" key={p.id}>
          <Avatar name={p.name} userId={p.id} />
          <span>
            {p.name}
            {p.guest && <span className="tag">{t("Gast", "Guest")}</span>}
            <small>{p.email}</small>
          </span>
          {shares.manage ? (
            roleSelect(p.role, t(`Seitenrechte für ${p.name}`, `Page permissions for ${p.name}`), (value) => void command({ action: "page.shareUpdate", userId: p.id, role: value }))
          ) : (
            <small>{p.role === "editor" ? t("Bearbeiten", "Edit") : t("Ansehen", "View||role")}</small>
          )}
        </div>
      ))}
      {shares?.pending.map((p) => (
        <div className="member-row" key={p.email}>
          <Avatar name={p.email} userId={null} />
          <span>
            {p.email}
            <small>{t("Eingeladen, noch kein Konto", "Invited, no account yet")}</small>
          </span>
          {roleSelect(p.role, t(`Seitenrechte für ${p.email}`, `Page permissions for ${p.email}`), (value) => void command({ action: "page.shareUpdate", email: p.email, role: value }))}
        </div>
      ))}
      {shares && !shares.manage && (
        <p className="muted small">
          {t("Personen hinzufügen können Eigentümer des Arbeitsbereichs und des Bereichs.", "Owners of the workspace and of the space can add people.")}
        </p>
      )}
    </div>
  );
}
