"use client";
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
      <h2>Arbeitsbereich verlassen oder löschen</h2>
      <p>
        Beim Verlassen bleiben die Inhalte für die übrigen Mitglieder erhalten.
      </p>
      {lastOwner && (
        <p className="muted">
          Übertrage zuerst unter „Mitglieder“ die Eigentümerrolle an ein aktives
          Mitglied, bevor du den Arbeitsbereich verlässt.
        </p>
      )}
      <div className="lifecycle-buttons">
        <button
          className="button"
          disabled={lastOwner || (owned && !owners.length)}
          onClick={() => open("leave")}
        >
          Arbeitsbereich verlassen
        </button>
        {boot.workspace.role === "owner" && (
          <button
            className="button danger"
            disabled={!canDelete}
            onClick={() => open("delete")}
          >
            Arbeitsbereich löschen
          </button>
        )}
      </div>
      {boot.workspace.role === "owner" && !canDelete && (
        <p className="muted">
          Lege zuerst einen weiteren Arbeitsbereich an, um diesen endgültig
          löschen zu können.
        </p>
      )}
      {mode && (
        <Modal
          open
          title={
            mode === "delete"
              ? "Arbeitsbereich endgültig löschen"
              : "Arbeitsbereich verlassen"
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
                ? "Alle Bereiche, Seiten, Einträge, Vorlagen und Anhänge werden für sämtliche Mitglieder endgültig gelöscht, auch private Inhalte und der Papierkorb. Veröffentlichungen, Freigabelinks und Formulare werden widerrufen. Diese Aktion kann nicht rückgängig gemacht werden."
                : "Du verlierst deinen Zugriff auf diesen Arbeitsbereich. Eine erneute Einladung ist nötig, um wieder beizutreten. Deine anderen Arbeitsbereiche und deine Anmeldung bleiben erhalten."}
            </p>
            {mode === "leave" && owned && (
              <label>
                Eigene Bereiche übertragen an
                <select
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  disabled={busy}
                >
                  {owners.map((owner) => (
                    <option key={owner.id} value={owner.id}>
                      {owner.name}
                    </option>
                  ))}
                </select>
                <small>
                  Dies umfasst deine privaten Bereiche und Bereiche im
                  Papierkorb. Der gewählte Eigentümer erhält Zugriff darauf.
                </small>
              </label>
            )}
            <label>
              Arbeitsbereichsname zur Bestätigung
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
                Abbrechen
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
                  ? "Wird ausgeführt …"
                  : mode === "delete"
                    ? "Endgültig löschen"
                    : "Verlassen"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
