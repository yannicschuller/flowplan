"use client";
// Settings → Konto & Sicherheit → Gefahrenzone: deleting one's own account. Shows what
// happens first (workspaces deleted, workspaces handed over), then asks for
// the password – or, for SSO accounts, the e-mail address.
import { useState, type FormEvent } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { api, Modal } from "./ui";
import { Select } from "./select";

type Plan = {
  removed: { id: string; name: string }[];
  handedOver: { id: string; name: string; to: string; toId: string; candidates: { id: string; name: string }[] }[];
  privateSpaces: number;
  confirm: { kind: "password" | "text"; text: string };
  refusal?: string;
};

export function DeleteOwnAccount() {
  const t = useT();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [successors, setSuccessors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const open = async () => {
    setError("");
    setBusy(true);
    try {
      const next = await api<Plan>("/api/command", { action: "account.deletePlan" });
      setSuccessors(Object.fromEntries(next.handedOver.map((w) => [w.id, w.toId])));
      setPlan(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("confirm") || "");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/account-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(plan?.confirm.kind === "password" ? { password: value } : { confirm: value }), successors }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(serverMessage(data.error) || response.statusText);
      // Signed out: the sign-in page.
      window.location.replace("/");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="button danger" disabled={busy} onClick={open}>
        {t("Konto löschen …", "Delete account …")}
      </button>
      {!plan && error && <span role="alert" className="save-state error">{error}</span>}
      <Modal open={!!plan} onClose={() => !busy && setPlan(null)} title={t("Dein Konto löschen?", "Delete your account?")}>
        {plan && (
          <form method="post" action="/api/auth/no-script" className="delete-account" onSubmit={submit}>
            {plan.refusal ? (
              <p role="alert">{serverMessage(plan.refusal)}</p>
            ) : (
              <p>{t("Das lässt sich nicht rückgängig machen. Danach bist du abgemeldet.", "This cannot be undone. You will be signed out afterwards.")}</p>
            )}
            <ul>
              <li>{t("Name, E-Mail-Adresse, Passwort, Passkeys, Sitzungen und persönliche Einstellungen werden gelöscht.", "Name, e-mail address, password, passkeys, sessions and personal settings are deleted.")}</li>
              {plan.removed.length > 0 && (
                <li>
                  {t("Diese Arbeitsbereiche haben nur dich als Mitglied und werden mit allen Inhalten gelöscht:", "These workspaces have only you as a member and are deleted with all content:")}{" "}
                  <strong>{plan.removed.map((w) => w.name).join(", ")}</strong>
                </li>
              )}
              {plan.handedOver.map((w) =>
                w.candidates.length > 1 && !plan.refusal ? (
                  <li key={w.id}>
                    <label className="delete-account-successor">
                      {t(`Neuer Eigentümer von „${w.name}“:`, `New owner of “${w.name}”:`)}
                      <Select
                        name={`successor-${w.id}`}
                        value={successors[w.id]}
                        onChange={(e) => setSuccessors({ ...successors, [w.id]: e.target.value })}
                      >
                        {w.candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  </li>
                ) : (
                  <li key={w.id}>{t(`„${w.name}“ bekommt ${w.to} als Eigentümer.`, `“${w.name}” gets ${w.to} as owner.`)}</li>
                ),
              )}
              {plan.privateSpaces > 0 && <li>{t(`${plan.privateSpaces} private Bereiche werden gelöscht.`, `${plan.privateSpaces} private spaces are deleted.`)}</li>}
              <li>{t("Beiträge in gemeinsamen Arbeitsbereichen (Seiten, Einträge, Kommentare, Dateien) bleiben und erscheinen als „Gelöschtes Konto“.", "Contributions to shared workspaces (pages, records, comments, files) stay and appear as “Deleted account”.")}</li>
            </ul>
            {!plan.refusal && (
              <label className="delete-account-confirm">
                {plan.confirm.kind === "password"
                  ? t("Zur Bestätigung dein Passwort:", "Your password to confirm:")
                  : t(`Zur Bestätigung „${plan.confirm.text}“ eingeben:`, `Type “${plan.confirm.text}” to confirm:`)}
                <input
                  name="confirm"
                  type={plan.confirm.kind === "password" ? "password" : "text"}
                  autoComplete={plan.confirm.kind === "password" ? "current-password" : "off"}
                  required
                  autoFocus
                />
              </label>
            )}
            {error && <p role="alert" className="error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="button" disabled={busy} onClick={() => setPlan(null)}>
                {plan.refusal ? t("Schließen", "Close") : t("Abbrechen", "Cancel")}
              </button>
              {!plan.refusal && (
                <button type="submit" className="button danger-solid" disabled={busy}>
                  {busy ? t("Löscht …", "Deleting …") : t("Konto endgültig löschen", "Delete account permanently")}
                </button>
              )}
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
