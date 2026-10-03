"use client";
import { useT } from "./i18n";
import { Select } from "./select";
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
  const t = useT();
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
    ? t("Bereich endgültig löschen", "Delete space permanently")
    : removing
      ? t("Bereich in den Papierkorb verschieben", "Move space to trash")
      : duplicating
        ? t("Bereich duplizieren", "Duplicate space")
        : t("Bereich verwalten", "Manage space");
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
                ? t("Alle Seiten, Einträge und Anhänge dieses Bereichs werden dauerhaft gelöscht. Das kann nicht rückgängig gemacht werden.", "All pages, records and attachments of this space are deleted permanently. This cannot be undone.")
                : t("Alle Seiten dieses Bereichs werden in den Papierkorb verschoben. Der Bereich kann wiederhergestellt werden. Öffentliche Seiten, Freigabelinks und Formulare werden deaktiviert und bei der Wiederherstellung nicht erneut freigegeben.", "All pages of this space move to the trash. The space can be restored. Public pages, share links and forms are switched off and not shared again when restoring.")}
            </p>
            <label>
              {t("Bereichsname zur Bestätigung", "Space name to confirm")}
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
                {t("Alle aktiven Seiten, Datenbanken, Einträge und Anhänge werden als unabhängige Kopien angelegt. Interne Links bleiben innerhalb der Kopie verbunden. Kommentare, Verlauf, Freigaben und Papierkorb werden nicht übernommen; kopierte Formulare sind zunächst deaktiviert.", "All active pages, databases, records and attachments are created as independent copies. Internal links stay connected within the copy. Comments, history, shares and trash are not copied; copied forms start switched off.")}
              </p>
            )}
            <label>
              {t("Name", "Name")}
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
              {t("Sichtbarkeit", "Visibility")}
              <Select
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as Space["visibility"])
                }
                disabled={busy}
              >
                <option value="team">{t("Gesamtes Team", "Whole team")}</option>
                <option value="private">{t("Nur Berechtigte", "Only people with access")}</option>
              </Select>
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
                  {t("Bereich duplizieren", "Duplicate space")}
                </button>
                <button
                  type="button"
                  className="button danger"
                  onClick={() => setRemoving(true)}
                  disabled={busy}
                >
                  {t("Bereich löschen", "Delete space")}
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
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            className={`button ${removing ? "danger" : "primary"}`}
            disabled={
              busy || (removing ? confirmation !== space.name : !name.trim())
            }
          >
            {busy
              ? t("Wird gespeichert …", "Saving …")
              : purge
                ? t("Endgültig löschen", "Delete permanently")
                : removing
                  ? t("In den Papierkorb", "Move to trash")
                  : duplicating
                    ? t("Kopie erstellen", "Create copy")
                    : t("Speichern", "Save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
