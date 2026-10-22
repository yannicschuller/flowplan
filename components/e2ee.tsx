"use client";
// End-to-end encrypted spaces in the interface (docs/e2ee-design.md): key
// setup with the recovery key, the unlock dialog, the page gate in front of
// the encrypted editor, the members of a space and the key settings.
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { LockKey, LockKeyOpen, Printer, DownloadSimple, Warning } from "@phosphor-icons/react";
import { Modal, download } from "./ui";
import { useT } from "./i18n";
import { CONTROL, SettingGroup, SettingRow, StatusBadge } from "./settings-ui";
import { Select } from "./select";
import type { SaveStatus } from "@/lib/save-status";
import type { Page, Space } from "@/lib/types";
import {
  AUTOLOCK_CHOICES,
  addMember,
  autoLockMinutes,
  changePassphrase,
  decryptTitles,
  decryptedTitle,
  encryptTitle,
  loadIdentity,
  lockSoon,
  newRecoveryKey,
  openSpace,
  openedSpace,
  prepareIdentity,
  recover,
  removeMember,
  resetIdentity,
  setAutoLockMinutes,
  unlock,
  useE2ee,
  type SpaceInfo,
} from "./e2ee-store";

const EncryptedEditor = dynamic(() => import("./encrypted-editor"), { ssr: false });
export const MIN_PASSPHRASE = 10;

// ---- Setup: passphrase, then the recovery key ----

function recoverySheet(key: string, t: (de: string, en: string) => string) {
  return [
    t("Flowplan – Wiederherstellungsschlüssel", "Flowplan – recovery key"),
    "",
    key,
    "",
    t(
      "Mit diesem Schlüssel öffnest du deine verschlüsselten Bereiche, wenn du die Passphrase vergessen hast. Bewahre ihn offline und sicher auf. Wer ihn hat, kann deine verschlüsselten Inhalte lesen.",
      "This key opens your encrypted spaces if you forget your passphrase. Keep it offline and safe. Whoever has it can read your encrypted content.",
    ),
    t(
      "Ohne Passphrase und ohne diesen Schlüssel sind die Daten verloren – auch der Betreiber kann sie nicht wiederherstellen.",
      "Without the passphrase and without this key the data is lost – the operator cannot restore it either.",
    ),
  ].join("\n");
}
export function E2eeSetupDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const t = useT();
  const [passphrase, setPassphrase] = useState(""),
    [repeat, setRepeat] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [prepared, setPrepared] = useState<Awaited<ReturnType<typeof prepareIdentity>> | null>(null),
    [kept, setKept] = useState(false);
  useEffect(() => {
    if (!open) {
      setPassphrase("");
      setRepeat("");
      setPrepared(null);
      setKept(false);
      setError("");
    }
  }, [open]);
  const print = (key: string) => {
    const win = window.open("", "_blank", "noopener=no,width=640,height=480");
    if (!win) return;
    const pre = win.document.createElement("pre");
    pre.style.cssText = "font:16px/1.6 monospace;white-space:pre-wrap;padding:24px";
    pre.textContent = recoverySheet(key, t);
    win.document.body.append(pre);
    win.print();
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Verschlüsselung einrichten", "Set up encryption")}>
      {!prepared ? (
        <form
          className="e2ee-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (passphrase.length < MIN_PASSPHRASE) return setError(t(`Die Passphrase braucht mindestens ${MIN_PASSPHRASE} Zeichen.`, `The passphrase needs at least ${MIN_PASSPHRASE} characters.`));
            if (passphrase !== repeat) return setError(t("Die Passphrasen stimmen nicht überein.", "The passphrases do not match."));
            setBusy(true);
            setError("");
            try {
              setPrepared(await prepareIdentity(passphrase));
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            {t(
              "Verschlüsselte Bereiche werden in deinem Browser ver- und entschlüsselt. Der Server speichert nur Chiffretext – auch Betreiber und Sicherungen können die Inhalte nicht lesen.",
              "Encrypted spaces are encrypted and decrypted in your browser. The server stores only ciphertext – neither the operators nor backups can read the content.",
            )}
          </p>
          <label>
            {t("Passphrase", "Passphrase")}
            <input type="password" autoComplete="new-password" autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} minLength={MIN_PASSPHRASE} required />
          </label>
          <label>
            {t("Passphrase wiederholen", "Repeat passphrase")}
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
          </label>
          <p className="muted">
            {t(
              "Die Passphrase verlässt deinen Browser nie. Sie ist nicht dein Anmeldepasswort – wähle eine eigene, lange.",
              "The passphrase never leaves your browser. It is not your sign-in password – choose a separate, long one.",
            )}
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button primary" disabled={busy}>
            {busy ? t("Schlüssel werden erzeugt …", "Generating keys …") : t("Weiter", "Continue")}
          </button>
        </form>
      ) : (
        <div className="e2ee-form">
          <p className="e2ee-warning" role="alert">
            <Warning size={18} weight="fill" />
            {t(
              "Wenn du Passphrase und Wiederherstellungsschlüssel verlierst, sind deine verschlüsselten Daten verloren. Niemand kann sie wiederherstellen.",
              "If you lose both the passphrase and the recovery key, your encrypted data is lost. Nobody can restore it.",
            )}
          </p>
          <p>{t("Dein Wiederherstellungsschlüssel:", "Your recovery key:")}</p>
          <code className="e2ee-recovery" data-testid="recovery-key">
            {prepared.recoveryKey}
          </code>
          <div className="e2ee-actions">
            <button type="button" className="button" onClick={() => download("flowplan-recovery-key.txt", recoverySheet(prepared.recoveryKey, t))}>
              <DownloadSimple size={16} /> {t("Herunterladen", "Download")}
            </button>
            <button type="button" className="button" onClick={() => print(prepared.recoveryKey)}>
              <Printer size={16} /> {t("Drucken", "Print")}
            </button>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
            {t("Ich habe den Wiederherstellungsschlüssel sicher aufbewahrt.", "I have stored the recovery key safely.")}
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button
            className="button primary"
            disabled={!kept || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await prepared.commit();
                onClose();
                onDone?.();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Einrichtung abschließen", "Finish setup")}
          </button>
        </div>
      )}
    </Modal>
  );
}

// ---- Unlock (passphrase, or recovery key plus a new passphrase) ----

export function E2eeUnlockDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<"passphrase" | "recovery">("passphrase"),
    [passphrase, setPassphrase] = useState(""),
    [recovery, setRecovery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) {
      setPassphrase("");
      setRecovery("");
      setError("");
      setMode("passphrase");
    }
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={t("Verschlüsselte Bereiche entsperren", "Unlock encrypted spaces")}>
      <form
        className="e2ee-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (mode === "passphrase") await unlock(passphrase);
            else {
              if (passphrase.length < MIN_PASSPHRASE)
                throw new Error(t(`Die Passphrase braucht mindestens ${MIN_PASSPHRASE} Zeichen.`, `The passphrase needs at least ${MIN_PASSPHRASE} characters.`));
              await recover(recovery, passphrase);
            }
            onClose();
            onDone?.();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {mode === "recovery" && (
          <label>
            {t("Wiederherstellungsschlüssel", "Recovery key")}
            <input autoFocus value={recovery} onChange={(e) => setRecovery(e.target.value)} autoComplete="off" spellCheck={false} required />
          </label>
        )}
        <label>
          {mode === "passphrase" ? t("Passphrase", "Passphrase") : t("Neue Passphrase", "New passphrase")}
          <input
            type="password"
            autoFocus={mode === "passphrase"}
            autoComplete={mode === "passphrase" ? "current-password" : "new-password"}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            required
          />
        </label>
        <p className="muted">
          {t(
            `Entsperrt bleibt es nur in diesem Tab und sperrt sich nach ${autoLockMinutes()} Minuten ohne Aktivität.`,
            `It stays unlocked only in this tab and locks itself after ${autoLockMinutes()} minutes without activity.`,
          )}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary" disabled={busy}>
          {busy ? t("Wird entschlüsselt …", "Decrypting …") : mode === "passphrase" ? t("Entsperren", "Unlock") : t("Wiederherstellen", "Recover")}
        </button>
        <button type="button" className="text-button" onClick={() => setMode(mode === "passphrase" ? "recovery" : "passphrase")}>
          {mode === "passphrase" ? t("Passphrase vergessen? Mit Wiederherstellungsschlüssel öffnen", "Forgot the passphrase? Open with the recovery key") : t("Mit Passphrase entsperren", "Unlock with passphrase")}
        </button>
      </form>
    </Modal>
  );
}

// ---- The page: setup, unlock or key missing, else the editor ----

export function EncryptedPage({
  userId,
  page,
  spaceId,
  title,
  editable,
  onStatus,
  onError,
}: {
  userId: string;
  page: Page;
  spaceId: string;
  title: string;
  editable: boolean;
  onStatus: (status: SaveStatus) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const state = useE2ee();
  const [dialog, setDialog] = useState<"setup" | "unlock" | null>(null);
  const [space, setSpace] = useState<"loading" | "missing" | "open">("loading");
  useEffect(() => {
    void loadIdentity(userId).catch((e) => onError((e as Error).message));
  }, [userId]);
  useEffect(() => {
    if (!state.unlocked) return setSpace("loading");
    let alive = true;
    openSpace(spaceId)
      .then((open) => alive && setSpace(open ? "open" : "missing"))
      .catch((e) => {
        if (!alive) return;
        setSpace("missing");
        onError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [state.unlocked, spaceId]);
  const gate = (text: string, action?: { label: string; run: () => void }) => (
    <div className="e2ee-gate">
      <LockKey size={40} weight="duotone" />
      <p>{text}</p>
      {action && (
        <button className="button primary" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
  let content;
  if (state.identity === undefined) content = gate(t("Wird geladen …", "Loading …"));
  else if (!state.identity)
    content = gate(t("Diese Seite ist Ende-zu-Ende-verschlüsselt. Richte zuerst deine Schlüssel ein.", "This page is end-to-end encrypted. Set up your keys first."), {
      label: t("Verschlüsselung einrichten", "Set up encryption"),
      run: () => setDialog("setup"),
    });
  else if (!state.unlocked)
    content = gate(t("Diese Seite ist Ende-zu-Ende-verschlüsselt.", "This page is end-to-end encrypted."), {
      label: t("Entsperren", "Unlock"),
      run: () => setDialog("unlock"),
    });
  else if (space === "loading") content = gate(t("Wird entschlüsselt …", "Decrypting …"));
  else if (space === "missing")
    content = gate(
      t(
        "Dir fehlt der Schlüssel dieses Bereichs. Ein Mitglied, das ihn hat, muss dich unter „Mitglieder und Schlüssel“ hinzufügen.",
        "You do not have the key of this space. A member who has it must add you under “Members and keys”.",
      ),
    );
  else
    content = (
      <EncryptedEditor key={page.id} pageId={page.id} spaceId={spaceId} title={title} editable={editable} onStatus={onStatus} onError={onError} />
    );
  return (
    <>
      {content}
      <E2eeSetupDialog open={dialog === "setup"} onClose={() => setDialog(null)} />
      <E2eeUnlockDialog open={dialog === "unlock"} onClose={() => setDialog(null)} />
    </>
  );
}

// ---- Titles ----

type TitledPage = Page & { title_cipher?: string | null };
// Pages with their titles decrypted where this tab holds the key.
export function useDecryptedTitles<P extends TitledPage>(pages: P[], spaces: (Space & { encrypt_titles?: number })[]): P[] {
  const state = useE2ee();
  const encrypted = useMemo(() => pages.filter((p) => p.title_cipher), [pages]);
  useEffect(() => {
    if (!state.unlocked || !encrypted.length) return;
    let alive = true;
    void (async () => {
      for (const sid of new Set(encrypted.map((p) => p.space_id)))
        if (!openedSpace(sid) && spaces.some((s) => s.id === sid)) await openSpace(sid).catch(() => null);
      if (alive) await decryptTitles(encrypted);
    })();
    return () => {
      alive = false;
    };
  }, [state.unlocked, encrypted, spaces]);
  return useMemo(
    () =>
      encrypted.length
        ? pages.map((p) => {
            const title = decryptedTitle(p.id, p.title_cipher);
            return title === undefined ? p : { ...p, title };
          })
        : pages,
    // The revision changes when titles were decrypted or the keys locked.
    [pages, encrypted, state.revision],
  );
}
// The title field of a page whose title is encrypted.
export function EncryptedTitleInput({
  page,
  title,
  editable,
  onSave,
  onError,
}: {
  page: TitledPage;
  title: string;
  editable: boolean;
  onSave: (cipher: string) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const state = useE2ee();
  const known = !page.title_cipher || decryptedTitle(page.id, page.title_cipher) !== undefined;
  return (
    <input
      key={`${page.id}-title-${known}-${state.unlocked}`}
      className="page-title"
      aria-label={t("Seitentitel", "Page title")}
      defaultValue={known && state.unlocked ? (page.title_cipher ? title : "") : ""}
      placeholder={state.unlocked ? t("Ohne Titel", "Untitled") : t("Verschlüsselter Titel", "Encrypted title")}
      readOnly={!editable || !state.unlocked}
      onBlur={async (e) => {
        const value = e.target.value.trim();
        if (!value || value === title) return;
        try {
          await onSave(await encryptTitle(page.space_id, page.id, value));
        } catch (err) {
          onError((err as Error).message);
        }
      }}
    />
  );
}

// ---- Members and keys of a space ----

export function EncryptedSpaceMembers({ spaceId, userId, open, onClose, onChanged }: { spaceId: string; userId: string; open: boolean; onClose: () => void; onChanged?: () => void }) {
  const t = useT();
  const state = useE2ee();
  const [info, setInfo] = useState<SpaceInfo | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [role, setRole] = useState<"editor" | "viewer">("editor"),
    [unlocking, setUnlocking] = useState(false);
  useEffect(() => {
    if (!open || !state.unlocked) return;
    void loadIdentity(userId);
    openSpace(spaceId, true)
      .then((space) => setInfo(space?.info || null))
      .catch((e) => setError((e as Error).message));
  }, [open, state.unlocked, spaceId]);
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await task();
      setInfo(openedSpace(spaceId)?.info || null);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Mitglieder und Schlüssel", "Members and keys")}>
      {!state.unlocked ? (
        <div className="e2ee-form">
          <p>{t("Zum Verwalten der Schlüssel zuerst entsperren.", "Unlock first to manage the keys.")}</p>
          <button className="button primary" onClick={() => setUnlocking(true)}>
            {t("Entsperren", "Unlock")}
          </button>
          <E2eeUnlockDialog open={unlocking} onClose={() => setUnlocking(false)} />
        </div>
      ) : !info ? (
        <p className="muted">{error || t("Wird geladen …", "Loading …")}</p>
      ) : (
        <div className="e2ee-form">
          <p className="muted">
            {t(
              `Schlüsselversion ${info.keyVersion}. Wer hinzukommt, erhält alle Schlüsselversionen und liest auch ältere Inhalte. Wer entfernt wird, liest neue Inhalte nicht mehr – was er früher schon entschlüsseln konnte, bleibt ihm aber bekannt.`,
              `Key version ${info.keyVersion}. Whoever is added receives all key versions and reads older content too. Whoever is removed cannot read new content – but what they could decrypt before stays known to them.`,
            )}
          </p>
          <h3>{t("Mitglieder mit Schlüssel", "Members with the key")}</h3>
          <ul className="e2ee-members">
            {info.holders.map((h) => (
              <li key={h.userId}>
                <span>{h.name}</span>
                {h.userId !== info.ownerId && (info.manage || h.userId === userId) && (
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() =>
                      run(() => removeMember(spaceId, h.userId))
                    }
                  >
                    {h.userId === userId ? t("Bereich verlassen", "Leave space") : t("Entfernen", "Remove")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {info.manage && (
            <>
              <h3>{t("Hinzufügen", "Add")}</h3>
              {info.candidates.length ? (
                <>
                  <label>
                    {t("Rolle", "Role")}
                    <select value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")}>
                      <option value="editor">{t("Bearbeiten", "Edit")}</option>
                      <option value="viewer">{t("Ansehen", "View")}</option>
                    </select>
                  </label>
                  <ul className="e2ee-members">
                    {info.candidates.map((c) => (
                      <li key={c.userId}>
                        <span>
                          {c.name} <small className="muted">{c.email}</small>
                        </span>
                        <button className="button compact" disabled={busy} onClick={() => run(() => addMember(spaceId, c, role))}>
                          {t("Schlüssel geben", "Give key")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">{t("Niemand sonst im Arbeitsbereich hat Schlüssel eingerichtet.", "Nobody else in the workspace has set up keys.")}</p>
              )}
              {info.withoutKeys.length > 0 && (
                <p className="muted">
                  {t("Noch ohne eigene Schlüssel (müssen erst die Verschlüsselung einrichten):", "Without keys yet (they need to set up encryption first):")}{" "}
                  {info.withoutKeys.map((u) => u.name).join(", ")}
                </p>
              )}
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <p className="muted">
            {t(
              "Verschlüsselte Bereiche enthalten nur Dokumente. Datenbanken, Kommentare, Suche, KI, Freigabelinks und Veröffentlichung sind hier nicht verfügbar.",
              "Encrypted spaces hold documents only. Databases, comments, search, AI, share links and publishing are not available here.",
            )}
          </p>
          <a className="button" href={`/api/e2ee/spaces/${spaceId}/archive`} download>
            <DownloadSimple size={16} /> {t("Verschlüsseltes Archiv herunterladen", "Download encrypted archive")}
          </a>
        </div>
      )}
    </Modal>
  );
}

// ---- Settings: passphrase, recovery key, auto-lock ----

export function E2eeKeySettings({ userId, onError }: { userId: string; onError: (message: string) => void }) {
  const t = useT();
  const state = useE2ee();
  const [dialog, setDialog] = useState<"setup" | "unlock" | "passphrase" | "recovery" | null>(null),
    [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [recoveryKey, setRecoveryKey] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    void loadIdentity(userId).catch((e) => onError((e as Error).message));
  }, [userId]);
  const close = () => {
    setDialog(null);
    setCurrent("");
    setNext("");
    setRecoveryKey("");
  };
  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingGroup
      id="encryption"
      title={t("Ende-zu-Ende-Verschlüsselung", "End-to-end encryption")}
      description={t(
        "Schlüssel für verschlüsselte Bereiche. Passphrase und Wiederherstellungsschlüssel kennt nur du – gehen beide verloren, sind die Daten verloren.",
        "Keys for encrypted spaces. Only you know the passphrase and the recovery key – if both are lost, the data is lost.",
      )}
    >
      {state.identity === undefined ? (
        <SettingRow label={t("Status", "Status")}>
          <span className="settings-loading" role="status">
            {t("Wird geladen …", "Loading …")}
          </span>
        </SettingRow>
      ) : state.identity === null ? (
        <SettingRow label={t("Status", "Status")} description={t("Noch nicht eingerichtet. Nötig für verschlüsselte Bereiche.", "Not set up yet. Needed for encrypted spaces.")}>
          <StatusBadge tone="off">{t("Nicht eingerichtet", "Not set up")}</StatusBadge>
          <button className="button" onClick={() => setDialog("setup")}>
            {t("Verschlüsselung einrichten", "Set up encryption")}
          </button>
        </SettingRow>
      ) : (
        <>
          <SettingRow label={t("Status", "Status")} description={state.unlocked ? t("In diesem Tab entsperrt.", "Unlocked in this tab.") : t("Zum Lesen verschlüsselter Bereiche entsperren.", "Unlock to read encrypted spaces.")}>
            {state.unlocked ? <StatusBadge tone="ok">{t("Entsperrt", "Unlocked")}</StatusBadge> : <StatusBadge tone="info">{t("Gesperrt", "Locked")}</StatusBadge>}
            {state.unlocked ? (
              <button className="button" onClick={() => void lockSoon()}>
                <LockKey size={16} aria-hidden /> {t("Jetzt sperren", "Lock now")}
              </button>
            ) : (
              <button className="button" onClick={() => setDialog("unlock")}>
                <LockKeyOpen size={16} aria-hidden /> {t("Entsperren", "Unlock")}
              </button>
            )}
          </SettingRow>
          <SettingRow id="e2ee-autolock" label={t("Automatisch sperren", "Lock automatically")} description={t("Nach so vielen Minuten ohne Aktivität.", "After this many minutes without activity.")}>
            <Select id="e2ee-autolock" className={CONTROL.sm} value={autoLockMinutes()} onChange={(e) => setAutoLockMinutes(Number(e.target.value))}>
              {AUTOLOCK_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {t(`${m} Minuten`, `${m} minutes`)}
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow label={t("Passphrase", "Passphrase")} description={t("Nicht dein Anmeldepasswort. Sie verlässt deinen Browser nie.", "Not your sign-in password. It never leaves your browser.")}>
            <button className="button" onClick={() => setDialog("passphrase")}>
              {t("Passphrase ändern", "Change passphrase")}
            </button>
          </SettingRow>
          <SettingRow label={t("Wiederherstellungsschlüssel", "Recovery key")} description={t("Ein neuer ersetzt den bisherigen.", "A new one replaces the previous one.")}>
            <button className="button" onClick={() => setDialog("recovery")}>
              {t("Neuen erzeugen", "Create a new one")}
            </button>
          </SettingRow>
        </>
      )}
      {message && (
        <p className="setting-note" role="status">
          {message}
        </p>
      )}
      <E2eeSetupDialog open={dialog === "setup"} onClose={close} />
      <E2eeUnlockDialog open={dialog === "unlock"} onClose={close} />
      <Modal open={dialog === "passphrase"} onClose={close} title={t("Passphrase ändern", "Change passphrase")}>
        <form
          className="e2ee-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (next.length < MIN_PASSPHRASE) return onError(t(`Die Passphrase braucht mindestens ${MIN_PASSPHRASE} Zeichen.`, `The passphrase needs at least ${MIN_PASSPHRASE} characters.`));
            void act(async () => {
              await changePassphrase(current, next);
              setMessage(t("Die Passphrase wurde geändert.", "The passphrase was changed."));
              close();
            });
          }}
        >
          <label>
            {t("Bisherige Passphrase", "Current passphrase")}
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label>
            {t("Neue Passphrase", "New passphrase")}
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
          </label>
          <button className="button primary" disabled={busy}>
            {t("Ändern", "Change")}
          </button>
        </form>
      </Modal>
      <Modal open={dialog === "recovery"} onClose={close} title={t("Neuer Wiederherstellungsschlüssel", "New recovery key")}>
        {recoveryKey ? (
          <div className="e2ee-form">
            <code className="e2ee-recovery">{recoveryKey}</code>
            <button type="button" className="button" onClick={() => download("flowplan-recovery-key.txt", recoverySheet(recoveryKey, t))}>
              <DownloadSimple size={16} /> {t("Herunterladen", "Download")}
            </button>
            <button className="button primary" onClick={close}>
              {t("Fertig", "Done")}
            </button>
          </div>
        ) : (
          <form
            className="e2ee-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => setRecoveryKey(await newRecoveryKey(current)));
            }}
          >
            <label>
              {t("Passphrase", "Passphrase")}
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </label>
            <button className="button primary" disabled={busy}>
              {t("Erzeugen", "Create")}
            </button>
          </form>
        )}
      </Modal>
    </SettingGroup>
  );
}

// The danger zone's row: new keys when passphrase and recovery key are both
// lost. Only shown once keys exist.
export function E2eeResetRow({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const state = useE2ee();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  if (!state.identity) return null;
  return (
    <SettingRow
      anchor="reset-keys"
      label={t("Schlüssel zurücksetzen", "Reset keys")}
      description={t("Nur wenn Passphrase und Wiederherstellungsschlüssel verloren sind: neue Schlüssel, alle Bereichsschlüssel sind weg.", "Only if passphrase and recovery key are lost: new keys, all space keys are gone.")}
    >
      <button className="button danger" onClick={() => setOpen(true)}>
        {t("Schlüssel zurücksetzen …", "Reset keys …")}
      </button>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title={t("Schlüssel zurücksetzen", "Reset keys")}>
        <div className="e2ee-form">
          <p className="e2ee-warning" role="alert">
            <Warning size={18} weight="fill" />
            {t(
              "Deine bisherigen Schlüssel werden gelöscht. Inhalte verschlüsselter Bereiche kannst du erst wieder lesen, wenn ein Mitglied dir den Bereichsschlüssel neu gibt. Bereiche, in denen nur du einen Schlüssel hattest, sind verloren.",
              "Your current keys are deleted. You can only read encrypted spaces again once a member gives you the space key again. Spaces where only you held a key are lost.",
            )}
          </p>
          <button
            className="button danger-solid"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resetIdentity();
                setOpen(false);
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Endgültig zurücksetzen", "Reset for good")}
          </button>
        </div>
      </Modal>
    </SettingRow>
  );
}
