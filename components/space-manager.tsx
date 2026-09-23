"use client";
import { SpaceAppearance } from "./space-appearance";
import { useState } from "react";
import { flushOpenDocuments } from "@/lib/document-flush";
import type { Space } from "@/lib/types";
import { api, Modal } from "./ui";
export function SpaceManager({
  space,
  purge = false,
  onClose,
  onDone,
}: {
  space: Space;
  purge?: boolean;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [removing, setRemoving] = useState(purge),
    [duplicating, setDuplicating] = useState(false),
    [icon, setIcon] = useState(space.icon),
    [color, setColor] = useState(space.icon_color || "none"),
    [name, setName] = useState(space.name),
    [visibility, setVisibility] = useState(space.visibility),
    [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const title = purge
    ? "Bereich endgültig löschen"
    : removing
      ? "Bereich in den Papierkorb verschieben"
      : duplicating
        ? "Bereich duplizieren"
        : "Bereich verwalten";
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if ((removing && !purge) || duplicating) await flushOpenDocuments();
      await api("/api/command", {
        action: duplicating
          ? "space.duplicate"
          : purge
            ? "space.purge"
            : removing
              ? "space.delete"
              : "space.update",
        spaceId: space.id,
        version: space.version || 1,
        name: name.trim(),
        private: visibility === "private",
        visibility,
        icon,
        iconColor: color,
        confirmName: confirmation,
      });
      await onDone();
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {removing ? (
          <>
            <p>
              <strong>{space.name}</strong>
            </p>
            <p>
              {purge
                ? "Alle Seiten, Einträge und Anhänge dieses Bereichs werden dauerhaft gelöscht. Das kann nicht rückgängig gemacht werden."
                : "Alle Seiten dieses Bereichs werden in den Papierkorb verschoben. Der Bereich kann wiederhergestellt werden. Öffentliche Seiten, Freigabelinks und Formulare werden deaktiviert und bei der Wiederherstellung nicht erneut freigegeben."}
            </p>
            <label>
              Bereichsname zur Bestätigung
              <input
                autoFocus
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                disabled={busy}
              />
            </label>
          </>
        ) : (
          <>
            {duplicating && (
              <p>
                Alle aktiven Seiten, Datenbanken, Einträge und Anhänge werden
                als unabhängige Kopien angelegt. Interne Links bleiben innerhalb
                der Kopie verbunden. Kommentare, Verlauf, Freigaben und
                Papierkorb werden nicht übernommen; kopierte Formulare sind
                zunächst deaktiviert.
              </p>
            )}
            <label>
              Name
              <input
                autoFocus
                required
                maxLength={500}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              Sichtbarkeit
              <select
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as Space["visibility"])
                }
                disabled={busy}
              >
                <option value="team">Gesamtes Team</option>
                <option value="private">Nur Berechtigte</option>
              </select>
            </label>
            {!duplicating && (
              <SpaceAppearance
                icon={icon}
                color={color}
                disabled={busy}
                onChange={(nextIcon, nextColor) => {
                  setIcon(nextIcon);
                  setColor(nextColor);
                }}
              />
            )}
            {!duplicating && (
              <div className="lifecycle-buttons">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setDuplicating(true);
                    setName(`${space.name.slice(0, 492)} (Kopie)`);
                    setVisibility("private");
                  }}
                >
                  Bereich duplizieren
                </button>
                <button
                  type="button"
                  className="button danger"
                  onClick={() => setRemoving(true)}
                  disabled={busy}
                >
                  Bereich löschen
                </button>
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="lifecycle-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            Abbrechen
          </button>
          <button
            className={`button ${removing ? "danger" : "primary"}`}
            disabled={
              busy || (removing ? confirmation !== space.name : !name.trim())
            }
          >
            {busy
              ? "Wird gespeichert …"
              : purge
                ? "Endgültig löschen"
                : removing
                  ? "In den Papierkorb"
                  : duplicating
                    ? "Kopie erstellen"
                    : "Speichern"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
