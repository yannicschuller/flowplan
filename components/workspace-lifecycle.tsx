"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState } from "react";
import type { Bootstrap } from "@/lib/types";
import { api, Modal } from "./ui";
export function WorkspaceLifecycle({
  boot,
  onExit,
}: {
  boot: Bootstrap;
  onExit: (id: string | null) => Promise<unknown> | void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"delete" | "leave" | null>(null),
    [confirmation, setConfirmation] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const owners = boot.members.filter(
    (member) =>
      member.role === "owner" && member.id !== boot.user.id && !member.disabled,
  );
  const [target, setTarget] = useState(owners[0]?.id || "");
  const owned = [...boot.spaces, ...(boot.trashedSpaces || [])].some(
    (space) => space.owner_id === boot.user.id,
  );
  const lastOwner = boot.workspace.role === "owner" && !owners.length;
  const canDelete =
    boot.workspace.role === "owner" && boot.workspaces.length > 1;
  function open(value: "delete" | "leave") {
    setMode(value);
    setConfirmation("");
    setError("");
    setTarget(owners[0]?.id || "");
  }
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ nextWorkspaceId: string | null }>(
        "/api/command",
        {
          action: `workspace.${mode}`,
          workspaceId: boot.workspace.id,
          confirmName: confirmation,
          transferTo: owned ? target : undefined,
        },
      );
      await onExit(result.nextWorkspaceId);
      setMode(null);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section workspace-lifecycle">
      <h2>{t("Arbeitsbereich verlassen oder löschen", "Leave or delete workspace")}</h2>
      <p>
        {t("Beim Verlassen bleiben die Inhalte für die übrigen Mitglieder erhalten.", "When you leave, the content stays for the other members.")}
      </p>
      {lastOwner && (
        <p className="muted">
          {t("Übertrage zuerst unter „Mitglieder“ die Eigentümerrolle an ein aktives Mitglied, bevor du den Arbeitsbereich verlässt.", "First pass the owner role to an active member under “Members” before you leave the workspace.")}
        </p>
      )}
      <div className="lifecycle-buttons">
        <button
          className="button"
          disabled={lastOwner || (owned && !owners.length)}
          onClick={() => open("leave")}
        >
          {t("Arbeitsbereich verlassen", "Leave workspace")}
        </button>
        {boot.workspace.role === "owner" && (
          <button
            className="button danger"
            disabled={!canDelete}
            onClick={() => open("delete")}
          >
            {t("Arbeitsbereich löschen", "Delete workspace")}
          </button>
        )}
      </div>
      {boot.workspace.role === "owner" && !canDelete && (
        <p className="muted">
          {t("Lege zuerst einen weiteren Arbeitsbereich an, um diesen endgültig löschen zu können.", "Create another workspace first to be able to delete this one permanently.")}
        </p>
      )}
      {mode && (
        <Modal
          open
          title={
            mode === "delete"
              ? t("Arbeitsbereich endgültig löschen", "Delete workspace permanently")
              : t("Arbeitsbereich verlassen", "Leave workspace")
          }
          onClose={() => {
            if (!busy) setMode(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p>
              <strong>{boot.workspace.name}</strong>
            </p>
            <p>
              {mode === "delete"
                ? t("Alle Bereiche, Seiten, Einträge, Vorlagen und Anhänge werden für sämtliche Mitglieder endgültig gelöscht, auch private Inhalte und der Papierkorb. Veröffentlichungen, Freigabelinks und Formulare werden widerrufen. Diese Aktion kann nicht rückgängig gemacht werden.", "All spaces, pages, records, templates and attachments are deleted permanently for all members, including private content and the trash. Publications, share links and forms are revoked. This cannot be undone.")
                : t("Du verlierst deinen Zugriff auf diesen Arbeitsbereich. Eine erneute Einladung ist nötig, um wieder beizutreten. Deine anderen Arbeitsbereiche und deine Anmeldung bleiben erhalten.", "You lose access to this workspace. A new invitation is needed to join again. Your other workspaces and your sign-in stay.")}
            </p>
            {mode === "leave" && owned && (
              <label>
                {t("Eigene Bereiche übertragen an", "Hand your own spaces over to")}
                <Select
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  disabled={busy}
                >
                  {owners.map((owner) => (
                    <option key={owner.id} value={owner.id}>
                      {owner.name}
                    </option>
                  ))}
                </Select>
                <small>
                  {t("Dies umfasst deine privaten Bereiche und Bereiche im Papierkorb. Der gewählte Eigentümer erhält Zugriff darauf.", "This includes your private spaces and spaces in the trash. The chosen owner gets access to them.")}
                </small>
              </label>
            )}
            <label>
              {t("Arbeitsbereichsname zur Bestätigung", "Workspace name to confirm")}
              <input
                autoFocus
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                disabled={busy}
              />
            </label>
            {error && (
              <p role="alert" className="lifecycle-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="button"
                type="button"
                onClick={() => setMode(null)}
                disabled={busy}
              >
                {t("Abbrechen", "Cancel")}
              </button>
              <button
                className="button danger"
                disabled={
                  busy ||
                  confirmation !== boot.workspace.name ||
                  (mode === "leave" && owned && !target)
                }
              >
                {busy
                  ? t("Wird ausgeführt …", "Working …")
                  : mode === "delete"
                    ? t("Endgültig löschen", "Delete permanently")
                    : t("Verlassen", "Leave")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
