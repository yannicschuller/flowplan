"use client";
// Settings → Konto & Sicherheit → Nachricht bei Inaktivität (#282,
// lib/dead-man-switch.ts): one switch per workspace the person is a full
// member of – period, note, recipients, what counts as a sign of life, the
// coupling to emergency access (#281) – with its state ("nächste Erinnerung
// am …", "wird verschickt am …"), "Ich bin da" and a preview of the e-mail
// that renders it without sending.
import { useCallback, useEffect, useState } from "react";
import { useT } from "./i18n";
import { api, Modal } from "./ui";
import { Select } from "./select";
import { CONTROL, SettingGroup, SettingRow, StatusBadge, Switch } from "./settings-ui";
import { LOCALE_TAG } from "@/lib/locale-tag";
import {
  DEADMAN_DEFAULT_PERIOD,
  DEADMAN_MAX_NOTE,
  DEADMAN_MAX_RECIPIENTS,
  DEADMAN_PERIOD_DAYS,
  type DeadmanOverview,
  type DeadmanPreview,
  type DeadmanSource,
  type DeadmanWorkspace,
} from "@/lib/dead-man-kinds";

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(LOCALE_TAG, { dateStyle: "medium", timeStyle: "short" }) : "");
type Draft = { enabled: boolean; periodDays: number; note: string; recipients: string; source: DeadmanSource; grantEmergency: boolean };
const addresses = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);

export function DeadManSwitchSettings({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [data, setData] = useState<DeadmanOverview | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<DeadmanPreview | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<DeadmanOverview>("/api/deadman"));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (input: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await api<unknown>("/api/command", input);
      await load();
      return result ?? true;
    } catch (e) {
      onError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  if (!data)
    return (
      <SettingGroup id="deadman" title={t("Nachricht bei Inaktivität", "Inactivity message")}>
        <SettingRow label={t("Status", "Status")}>
          <span className="settings-loading" role="status">
            {t("Wird geladen …", "Loading …")}
          </span>
        </SettingRow>
      </SettingGroup>
    );
  const startEdit = (w: DeadmanWorkspace) => {
    const s = w.switch;
    setEditing(w.workspaceId);
    setDraft({
      enabled: s ? s.state !== "off" : true,
      periodDays: s?.periodDays ?? DEADMAN_DEFAULT_PERIOD,
      note: s?.note ?? "",
      recipients: (s?.recipients ?? []).join("\n"),
      source: s?.source ?? "account",
      grantEmergency: s?.grantEmergency ?? false,
    });
  };
  const body = (workspaceId: string, d: Draft) => ({
    workspaceId,
    enabled: d.enabled,
    periodDays: d.periodDays,
    note: d.note,
    recipients: addresses(d.recipients),
    source: d.source,
    grantEmergency: d.grantEmergency,
  });
  const status = (w: DeadmanWorkspace) => {
    const s = w.switch;
    if (!s || s.state === "off") return <StatusBadge tone="off">{t("Aus", "Off")}</StatusBadge>;
    if (s.state === "fired") return <StatusBadge tone="error">{t(`Verschickt am ${when(s.firedAt)}`, `Sent on ${when(s.firedAt)}`)}</StatusBadge>;
    return <StatusBadge tone={s.nextWarningAt && s.nextWarningAt <= Date.now() + 7 * 86_400_000 ? "warn" : "ok"}>{t("Eingeschaltet", "On")}</StatusBadge>;
  };
  const recipientCount = draft ? addresses(draft.recipients).length : 0;
  return (
    <SettingGroup
      id="deadman"
      title={t("Nachricht bei Inaktivität", "Inactivity message")}
      description={t(
        "Nutzt du Flowplan eine gewählte Zeit lang nicht, verschickt Flowplan eine Notiz von dir an Menschen, die du auswählst – etwa damit deine Familie weiß, wie sie an deine Daten kommt. Vorher erinnern wir dich 7, 3 und 1 Tag vorher; jede Nutzung setzt die Frist zurück.",
        "If you do not use Flowplan for a chosen time, Flowplan sends a note of yours to people you choose – so your family knows how to reach your data, for example. We remind you 7, 3 and 1 day before; any use resets the period.",
      )}
      actions={
        !data.enabled ? (
          <StatusBadge tone="off">{t("Von der Administration ausgeschaltet", "Switched off by the administration")}</StatusBadge>
        ) : !data.mail ? (
          <StatusBadge tone="off">{t("Nicht verfügbar", "Not available")}</StatusBadge>
        ) : undefined
      }
    >
      {!data.available && (
        <SettingRow label={t("Nicht verfügbar", "Not available")}>
          <p className="deadman-note">
            {!data.enabled
              ? t(
                  "Die Administration hat die Nachricht bei Inaktivität für diese Instanz ausgeschaltet. Solange werden keine Erinnerungen und keine Nachrichten verschickt.",
                  "The administration switched the inactivity message off for this instance. Meanwhile no reminders and no messages are sent.",
                )
              : t(
                  "Auf dieser Instanz ist kein E-Mail-Versand eingerichtet. Ohne ihn kann Flowplan dich nicht erinnern und keine Nachricht verschicken.",
                  "This instance has no e-mail delivery set up. Without it Flowplan can neither remind you nor send a message.",
                )}
          </p>
        </SettingRow>
      )}
      <SettingRow
        wide
        label={t("Deine Arbeitsbereiche", "Your workspaces")}
        description={t(
          "Eine Nachricht je Arbeitsbereich, höchstens drei. Die Empfänger brauchen kein Konto; sie bekommen nur deine Notiz, nichts aus dem Arbeitsbereich.",
          "One message per workspace, at most three. Recipients need no account; they only get your note, nothing from the workspace.",
        )}
      >
        <ul className="emergency-list">
          {data.workspaces.length === 0 && <li className="emergency-empty">{t("Du bist in keinem Arbeitsbereich Mitglied.", "You are not a member of any workspace.")}</li>}
          {data.workspaces.map((w) => {
            const s = w.switch;
            const open = editing === w.workspaceId && draft;
            return (
              <li key={w.workspaceId} className="emergency-item deadman-item">
                <span className="emergency-who">
                  <strong>{w.name}</strong>
                  {s && s.state !== "off" && (
                    <small>
                      {t(`${s.periodDays} Tage ohne Nutzung`, `${s.periodDays} days without use`)} ·{" "}
                      {s.source === "workspace" ? t("nur dieser Arbeitsbereich zählt", "only this workspace counts") : t("jede Nutzung des Kontos zählt", "any use of the account counts")} ·{" "}
                      {t(`an ${s.recipients.join(", ")}`, `to ${s.recipients.join(", ")}`)}
                    </small>
                  )}
                  {s?.state === "armed" && (
                    <small>
                      {s.nextWarningAt ? t(`Nächste Erinnerung am ${when(s.nextWarningAt)}`, `Next reminder on ${when(s.nextWarningAt)}`) + " · " : ""}
                      {t(`Wird verschickt am ${when(s.fireAt)}, wenn du dich bis dahin nicht meldest`, `Sent on ${when(s.fireAt)} unless you check in by then`)}
                    </small>
                  )}
                  {s?.state === "fired" && (
                    <small>
                      {t(
                        `Verschickt am ${when(s.firedAt)} an ${s.firedTo.join(", ")}. Mit deiner nächsten Nutzung ist sie wieder eingeschaltet.`,
                        `Sent on ${when(s.firedAt)} to ${s.firedTo.join(", ")}. It is switched on again with your next use.`,
                      )}
                    </small>
                  )}
                </span>
                {status(w)}
                <span className="emergency-actions">
                  {s && s.state !== "off" && (
                    <button className="button compact" disabled={busy} onClick={() => void act({ action: "deadman.checkin", workspaceId: w.workspaceId })}>
                      {t("Ich bin da", "I'm here")}
                    </button>
                  )}
                  {!open && (data.available || s) && (
                    <button className="button compact" disabled={busy} onClick={() => startEdit(w)}>
                      {s ? t("Bearbeiten", "Edit") : t("Einrichten", "Set up")}
                    </button>
                  )}
                </span>
                {open && (
                  <form
                    className="deadman-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await act({ action: "deadman.save", ...body(w.workspaceId, draft) })) {
                        setEditing(null);
                        setDraft(null);
                      }
                    }}
                  >
                    <label className="deadman-field deadman-inline">
                      <Switch checked={draft.enabled} disabled={!data.available && !draft.enabled} onChange={(on) => setDraft({ ...draft, enabled: on })} label={t("Eingeschaltet", "On")} />
                      <span>{t("Eingeschaltet", "On")}</span>
                    </label>
                    <div className="deadman-row">
                      <label className="deadman-field">
                        <span>{t("Verschicken nach", "Send after")}</span>
                        <Select className={CONTROL.sm} value={draft.periodDays} onChange={(e) => setDraft({ ...draft, periodDays: Number(e.target.value) })}>
                          {DEADMAN_PERIOD_DAYS.map((d) => (
                            <option key={d} value={d}>
                              {t(`${d} Tagen ohne Nutzung`, `${d} days without use`)}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label className="deadman-field">
                        <span>{t("Als Nutzung zählt", "Counts as use")}</span>
                        <Select className={CONTROL.md} value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value as DeadmanSource })}>
                          <option value="account">{t("Jede Nutzung meines Kontos", "Any use of my account")}</option>
                          <option value="workspace">{t("Nur Nutzung dieses Arbeitsbereichs", "Only use of this workspace")}</option>
                        </Select>
                      </label>
                    </div>
                    <label className="deadman-field">
                      <span>{t("Notiz", "Note")}</span>
                      <textarea
                        rows={6}
                        maxLength={DEADMAN_MAX_NOTE}
                        value={draft.note}
                        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                        placeholder={t("Was sollen deine Angehörigen wissen? Zum Beispiel, wo deine Zugangsdaten liegen.", "What should your relatives know? Where your credentials are kept, for example.")}
                      />
                      <small>
                        {t(`${draft.note.length} von ${DEADMAN_MAX_NOTE} Zeichen. Text oder Markdown, so wie geschrieben verschickt – schreib keine Passwörter hinein.`, `${draft.note.length} of ${DEADMAN_MAX_NOTE} characters. Text or Markdown, sent as written – do not put passwords in it.`)}
                      </small>
                    </label>
                    <label className="deadman-field">
                      <span>{t("Empfänger", "Recipients")}</span>
                      <textarea rows={3} value={draft.recipients} onChange={(e) => setDraft({ ...draft, recipients: e.target.value })} placeholder="name@example.com" />
                      <small>
                        {t(`Eine E-Mail-Adresse je Zeile, höchstens ${DEADMAN_MAX_RECIPIENTS} (jetzt ${recipientCount}). Jede Änderung melden wir dir per E-Mail.`, `One e-mail address per line, at most ${DEADMAN_MAX_RECIPIENTS} (now ${recipientCount}). We tell you of every change by e-mail.`)}
                      </small>
                    </label>
                    {data.emergency && (
                      <label className="deadman-field deadman-inline">
                        <Switch checked={draft.grantEmergency} onChange={(on) => setDraft({ ...draft, grantEmergency: on })} label={t("Notfallzugriff für meine Vertrauenspersonen sofort freigeben", "Grant emergency access to my trusted contacts at once")} />
                        <span>
                          {t("Notfallzugriff für meine Vertrauenspersonen sofort freigeben", "Grant emergency access to my trusted contacts at once")}
                          <small>
                            {data.trustedContacts
                              ? t(
                                  `Wird die Nachricht verschickt, bekommen deine Vertrauenspersonen (${data.trustedContacts}) ohne Wartezeit Lesezugriff – nur wer die Rolle schon mindestens so lange angenommen hat wie die eigene Wartezeit.`,
                                  `When the message is sent, your trusted contacts (${data.trustedContacts}) get read access without the waiting period – only those who accepted the role at least as long ago as their own waiting period.`,
                                )
                              : t("Du hast noch keine Vertrauenspersonen (siehe Notfallzugriff oben).", "You have no trusted contacts yet (see Emergency access above).")}
                          </small>
                        </span>
                      </label>
                    )}
                    <div className="emergency-actions">
                      <button className="button primary" type="submit" disabled={busy}>
                        {t("Speichern", "Save")}
                      </button>
                      <button
                        className="button"
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          const result = await act({ action: "deadman.preview", ...body(w.workspaceId, draft) });
                          if (result && typeof result === "object") setPreview(result as DeadmanPreview);
                        }}
                      >
                        {t("Vorschau der E-Mail", "Preview the e-mail")}
                      </button>
                      <button
                        className="button"
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setDraft(null);
                        }}
                      >
                        {t("Abbrechen", "Cancel")}
                      </button>
                      {s && (
                        <button
                          className="button danger"
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            if (await act({ action: "deadman.remove", workspaceId: w.workspaceId })) {
                              setEditing(null);
                              setDraft(null);
                            }
                          }}
                        >
                          {t("Entfernen", "Remove")}
                        </button>
                      )}
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </SettingRow>
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={t("Vorschau der E-Mail", "Preview of the e-mail")}
        wide
        actions={
          <button className="button" onClick={() => setPreview(null)}>
            {t("Schließen", "Close")}
          </button>
        }
      >
        {preview && (
          <div className="deadman-preview">
            <p className="deadman-note">{t("So sieht die E-Mail aus. Nichts wurde verschickt.", "This is what the e-mail looks like. Nothing was sent.")}</p>
            <dl>
              <dt>{t("Von", "From")}</dt>
              <dd>{preview.from}</dd>
              <dt>{t("An", "To")}</dt>
              <dd>{preview.to.join(", ") || "–"}</dd>
              <dt>{t("Betreff", "Subject")}</dt>
              <dd>{preview.subject}</dd>
            </dl>
            <pre className="emergency-markdown">{preview.text}</pre>
          </div>
        )}
      </Modal>
    </SettingGroup>
  );
}
