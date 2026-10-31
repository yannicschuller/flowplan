"use client";
// Settings → Benachrichtigungen → Chat-Apps (lib/messengers.ts): the
// person's connections to Telegram, Gotify, ntfy and Matrix, a test message
// per connection, whether messages carry the text or only a hint, and – for
// administrators – operations alerts. Tokens are written, never read back:
// a stored one shows as "…abcd"; an empty field keeps it.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowSquareOut, PaperPlaneTilt, Plus, Trash } from "@phosphor-icons/react";
import {
  messengerErrorText,
  messengerNames,
  NTFY_DEFAULT,
  TELEGRAM_API,
  type MessengerOverview,
  type MessengerService,
  type MessengerTarget,
  type TelegramLink,
} from "@/lib/messenger-services";
import { useLocale, useT } from "./i18n";
import { api } from "./ui";
import { Select } from "./select";
import { SettingGroup, SettingRow, StatusBadge, Switch } from "./settings-ui";

type Note = { tone: "ok" | "error" | "info"; text: string } | null;
type Form = { service: MessengerService; mode: "bot" | "own" } | null;

export function MessengerSettings({ overview, onChange }: { overview: MessengerOverview; onChange: (next: MessengerOverview) => void }) {
  const t = useT();
  const [form, setForm] = useState<Form>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const note = (key: string, value: Note) => setNotes((current) => ({ ...current, [key]: value }));
  const connected = new Set(overview.targets.map((target) => target.service));
  const addable = overview.services.filter((service) => !connected.has(service));

  const act = async (key: string, body: Record<string, unknown>, done?: string) => {
    setBusy(key);
    note(key, null);
    try {
      const next = await api<MessengerOverview>("/api/messengers", body);
      onChange(next);
      if (done) note(key, { tone: "ok", text: done });
      return true;
    } catch (e) {
      note(key, { tone: "error", text: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const test = async (target: MessengerTarget) => {
    setBusy(`test-${target.id}`);
    note(target.id, { tone: "info", text: t("Wird gesendet …", "Sending …") });
    try {
      const answer = await api<{ ok: boolean; error?: string; overview: MessengerOverview }>("/api/messengers", { action: "test", id: target.id });
      onChange(answer.overview);
      note(
        target.id,
        answer.ok
          ? { tone: "ok", text: t("Testnachricht gesendet – sieh in der App nach.", "Test message sent – check the app.") }
          : { tone: "error", text: messengerErrorText(answer.error, t) },
      );
    } catch (e) {
      note(target.id, { tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingGroup
      id="messengers"
      title={t("Chat-Apps", "Chat apps")}
      description={t(
        "Benachrichtigungen sofort in Telegram, Gotify, ntfy oder Matrix – welche Arten, stellst du oben in der Spalte „Chat-Apps“ ein. Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt.",
        "Notifications right away in Telegram, Gotify, ntfy or Matrix – choose the kinds above in the “Chat apps” column. Credentials are stored encrypted and never shown again.",
      )}
    >
      {overview.targets.map((target) => (
        <SettingRow
          key={target.id}
          label={messengerNames[target.service]}
          description={
            <span className="messenger-target-detail">
              <span className="messenger-target-where">{target.detail}</span>
              <span className="messenger-target-meta">
                <TargetState target={target} />
                {target.hasSecret && (
                  <span>{target.secretHint ? t(`Token gesetzt (${target.secretHint})`, `Token set (${target.secretHint})`) : t("Zugangsdaten gesetzt", "Credentials set")}</span>
                )}
              </span>
              {notes[target.id] ? (
                <span className="messenger-note" data-tone={notes[target.id]!.tone} role={notes[target.id]!.tone === "error" ? "alert" : "status"}>
                  {notes[target.id]!.text}
                </span>
              ) : (
                target.lastError &&
                target.enabled && (
                  <span className="messenger-note" data-tone="error">
                    {t("Zuletzt:", "Last time:")} {messengerErrorText(target.lastError, t)}
                  </span>
                )
              )}
            </span>
          }
        >
          <div className="messenger-actions">
            {!target.enabled && (
              <button type="button" className="button compact" disabled={!!busy} onClick={() => void act(target.id, { action: "enable", id: target.id })}>
                {t("Wieder einschalten", "Switch on again")}
              </button>
            )}
            <button
              type="button"
              className="button compact"
              disabled={!!busy || target.blocked}
              aria-busy={busy === `test-${target.id}`}
              onClick={() => void test(target)}
            >
              <PaperPlaneTilt size={15} aria-hidden /> {t("Testnachricht senden", "Send test message")}
            </button>
            {target.mode !== "bot" && !target.blocked && (
              <button type="button" className="button compact" disabled={!!busy} onClick={() => setForm({ service: target.service, mode: "own" })}>
                {t("Ändern", "Change")}
              </button>
            )}
            <button
              type="button"
              className="button compact"
              disabled={!!busy}
              aria-label={t(`${messengerNames[target.service]} trennen`, `Disconnect ${messengerNames[target.service]}`)}
              onClick={() => void act(target.id, { action: "remove", id: target.id })}
            >
              <Trash size={15} aria-hidden /> {t("Trennen", "Disconnect")}
            </button>
          </div>
        </SettingRow>
      ))}
      {!form && addable.length > 0 && (
        <SettingRow
          label={overview.targets.length ? t("Weitere Chat-App", "Another chat app") : t("Chat-App verbinden", "Connect a chat app")}
          description={t("Pro Dienst eine Verbindung.", "One connection per service.")}
        >
          <div className="messenger-choice">
            {addable.map((service) => (
              <button
                key={service}
                type="button"
                className="button compact"
                onClick={() => setForm({ service, mode: service === "telegram" && overview.bot ? "bot" : "own" })}
              >
                <Plus size={15} aria-hidden /> {messengerNames[service]}
              </button>
            ))}
          </div>
        </SettingRow>
      )}
      {form && (
        <ConnectForm
          key={`${form.service}-${form.mode}`}
          form={form}
          overview={overview}
          existing={overview.targets.find((target) => target.service === form.service && target.mode !== "bot")}
          onMode={(mode) => setForm({ ...form, mode })}
          onCancel={() => setForm(null)}
          onDone={(next) => {
            onChange(next);
            setForm(null);
          }}
          onLinked={onChange}
        />
      )}
      {overview.targets.length > 0 && (
        <>
          <SettingRow
            label={t("Text mitschicken", "Include the text")}
            description={
              <>
                {t(
                  "An: Art, kurzer Auszug und Link – wie bei Push. Aus: nur „Neue Benachrichtigung in Flowplan“ mit dem Link. Seiten in Ende-zu-Ende-verschlüsselten Bereichen kommen immer ohne Inhalt.",
                  "On: kind, a short excerpt and the link – as with push. Off: only “New notification in Flowplan” with the link. Pages in end-to-end encrypted spaces always arrive without content.",
                )}
                {notes.preview && (
                  <span className="messenger-note" data-tone={notes.preview.tone} role="alert">
                    {" "}
                    {notes.preview.text}
                  </span>
                )}
              </>
            }
          >
            <Switch
              label={t("Text mitschicken", "Include the text")}
              checked={overview.preview}
              disabled={busy === "preview"}
              onChange={(on) => void act("preview", { action: "settings", preview: on })}
            />
          </SettingRow>
          {overview.admin && (
            <SettingRow
              label={t("Betriebswarnungen", "Operations alerts")}
              description={t(
                "Für Administratoren: fehlgeschlagene Backups, voller Speicher, Fehler von Hintergrunddiensten und viele fehlgeschlagene Anmeldungen – höchstens einmal am Tag je Warnung. Sicherheitsvorfälle kommen als „Sicherheitshinweise“ (Spalte oben).",
                "For administrators: failed backups, full storage, errors of background workers and many failed sign-ins – at most once a day per alert. Security incidents arrive as “Security notices” (column above).",
              )}
            >
              <Switch
                label={t("Betriebswarnungen", "Operations alerts")}
                checked={overview.ops}
                disabled={busy === "ops"}
                onChange={(on) => void act("ops", { action: "settings", ops: on })}
              />
            </SettingRow>
          )}
        </>
      )}
    </SettingGroup>
  );
}

function TargetState({ target }: { target: MessengerTarget }) {
  const t = useT();
  if (target.blocked) return <StatusBadge tone="off">{t("Von der Instanz ausgeschaltet", "Switched off by the instance")}</StatusBadge>;
  if (!target.enabled)
    return (
      <StatusBadge tone="error" title={messengerErrorText(target.disabledReason, t)}>
        {t("Ausgeschaltet", "Switched off")}: {messengerErrorText(target.disabledReason, t)}
      </StatusBadge>
    );
  return <StatusBadge tone="ok">{t("Aktiv", "Active")}</StatusBadge>;
}

type Fields = Record<string, string>;

function ConnectForm({
  form,
  overview,
  existing,
  onMode,
  onCancel,
  onDone,
  onLinked,
}: {
  form: NonNullable<Form>;
  overview: MessengerOverview;
  existing?: MessengerTarget;
  onMode: (mode: "bot" | "own") => void;
  onCancel: () => void;
  onDone: (next: MessengerOverview) => void;
  onLinked: (next: MessengerOverview) => void;
}) {
  const t = useT();
  const [fields, setFields] = useState<Fields>({ auth: "none" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (key: string) => (e: { target: { value: string } }) => setFields((current) => ({ ...current, [key]: e.target.value }));
  const name = messengerNames[form.service];
  const kept = existing?.hasSecret ? t(`leer lassen: bleibt ${existing.secretHint || "gesetzt"}`, `leave empty: keeps ${existing.secretHint || "the stored one"}`) : "";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body: Record<string, unknown> = { action: "connect", service: form.service };
      for (const [key, value] of Object.entries(fields)) if (value.trim() || key === "password") body[key] = key === "password" ? value : value.trim();
      if (!body.password) delete body.password;
      onDone(await api<MessengerOverview>("/api/messengers", body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (form.service === "telegram" && form.mode === "bot" && overview.bot)
    return (
      <div className="messenger-form">
        <TelegramModes mode="bot" bot={overview.bot.username} onMode={onMode} />
        <TelegramBotLink onLinked={onLinked} onCancel={onCancel} />
      </div>
    );
  return (
    <form method="post" action="/api/auth/no-script" className="messenger-form" onSubmit={(e) => void submit(e)} aria-label={t(`${name} verbinden`, `Connect ${name}`)}>
      {form.service === "telegram" && overview.bot && <TelegramModes mode="own" bot={overview.bot.username} onMode={onMode} />}
      {form.service === "telegram" && (
        <>
          <label>
            {t("Bot-Token", "Bot token")}
            <input type="password" autoComplete="off" required={!existing?.hasSecret} placeholder="123456:ABC…" value={fields.token || ""} onChange={set("token")} />
            <small>{kept || t("Von @BotFather. Schreib deinem Bot einmal, damit er dir antworten darf.", "From @BotFather. Message your bot once so it may write to you.")}</small>
          </label>
          <label>
            {t("Chat-ID", "Chat ID")}
            <input required inputMode="numeric" placeholder="123456789" value={fields.chatId || ""} onChange={set("chatId")} />
            <small>{t("Deine Chat-ID (z. B. von @userinfobot) oder @kanalname.", "Your chat ID (e.g. from @userinfobot) or @channelname.")}</small>
          </label>
          <label>
            {t("API-Adresse (optional)", "API address (optional)")}
            <input type="url" placeholder={TELEGRAM_API} value={fields.apiUrl || ""} onChange={set("apiUrl")} />
            <small>{t("Für einen eigenen Bot-API-Server oder ein Relay.", "For an own Bot API server or a relay.")}</small>
          </label>
        </>
      )}
      {form.service === "gotify" && (
        <>
          <label>
            {t("Server-Adresse", "Server address")}
            <input type="url" required placeholder="https://gotify.example.org" value={fields.server || ""} onChange={set("server")} />
          </label>
          <label>
            {t("App-Token", "App token")}
            <input type="password" autoComplete="off" required={!existing?.hasSecret} value={fields.token || ""} onChange={set("token")} />
            <small>{kept || t("In Gotify unter Apps → neue App anlegen.", "In Gotify under Apps → create an app.")}</small>
          </label>
        </>
      )}
      {form.service === "ntfy" && (
        <>
          <label>
            {t("Server-Adresse", "Server address")}
            <input type="url" placeholder={NTFY_DEFAULT} value={fields.server || ""} onChange={set("server")} />
            <small>{t(`Leer: ${NTFY_DEFAULT}`, `Empty: ${NTFY_DEFAULT}`)}</small>
          </label>
          <label>
            {t("Thema", "Topic")}
            <input required pattern="[A-Za-z0-9_-]{1,64}" placeholder="flowplan-ada-7f3k" value={fields.topic || ""} onChange={set("topic")} />
            <small>{t("Auf ntfy.sh ist jedes Thema öffentlich lesbar – wähle einen schwer zu ratenden Namen.", "On ntfy.sh every topic can be read by anyone – choose a name that is hard to guess.")}</small>
          </label>
          <label>
            {t("Anmeldung", "Authentication")}
            <Select value={fields.auth} onChange={set("auth")}>
              <option value="none">{t("Keine", "None")}</option>
              <option value="token">{t("Zugriffstoken", "Access token")}</option>
              <option value="basic">{t("Benutzer und Passwort", "User and password")}</option>
            </Select>
          </label>
          {fields.auth === "token" && (
            <label>
              {t("Zugriffstoken", "Access token")}
              <input type="password" autoComplete="off" placeholder="tk_…" value={fields.token || ""} onChange={set("token")} />
              {kept && <small>{kept}</small>}
            </label>
          )}
          {fields.auth === "basic" && (
            <>
              <label>
                {t("Benutzer", "User")}
                <input autoComplete="off" required value={fields.user || ""} onChange={set("user")} />
              </label>
              <label>
                {t("Passwort", "Password")}
                <input type="password" autoComplete="new-password" value={fields.password || ""} onChange={set("password")} />
                {kept && <small>{kept}</small>}
              </label>
            </>
          )}
        </>
      )}
      {form.service === "matrix" && (
        <>
          <label>
            {t("Homeserver", "Homeserver")}
            <input type="url" required placeholder="https://matrix.example.org" value={fields.homeserver || ""} onChange={set("homeserver")} />
          </label>
          <label>
            {t("Raum-ID", "Room ID")}
            <input required pattern="![^:\s]+:\S+" placeholder="!abcdef:example.org" value={fields.room || ""} onChange={set("room")} />
            <small>{t("In Element unter Raumeinstellungen → Erweitert. Das Konto des Tokens muss im Raum sein.", "In Element under Room settings → Advanced. The token's account must be in the room.")}</small>
          </label>
          <label>
            {t("Zugriffstoken", "Access token")}
            <input type="password" autoComplete="off" required={!existing?.hasSecret} value={fields.token || ""} onChange={set("token")} />
            <small>{kept || t("Am besten eines eigenen Bot-Kontos.", "Preferably of a separate bot account.")}</small>
          </label>
        </>
      )}
      {overview.allowedHosts.length > 0 && form.service !== "telegram" && (
        <p className="messenger-note">
          {t(`Erlaubte Server auf dieser Instanz: ${overview.allowedHosts.join(", ")}`, `Servers allowed on this instance: ${overview.allowedHosts.join(", ")}`)}
        </p>
      )}
      {error && (
        <p className="messenger-note" data-tone="error" role="alert">
          {error}
        </p>
      )}
      <div className="messenger-actions">
        <button className="button primary" disabled={saving} aria-busy={saving}>
          {existing ? t("Speichern", "Save") : t(`${name} verbinden`, `Connect ${name}`)}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          {t("Abbrechen", "Cancel")}
        </button>
      </div>
    </form>
  );
}

function TelegramModes({ mode, bot, onMode }: { mode: "bot" | "own"; bot: string; onMode: (mode: "bot" | "own") => void }) {
  const t = useT();
  return (
    <div className="messenger-choice" role="radiogroup" aria-label={t("Art der Verbindung", "Kind of connection")}>
      <button type="button" role="radio" aria-checked={mode === "bot"} className={`button compact${mode === "bot" ? " primary" : ""}`} onClick={() => onMode("bot")}>
        {bot ? t(`Bot der Instanz (@${bot})`, `The instance's bot (@${bot})`) : t("Bot der Instanz", "The instance's bot")}
      </button>
      <button type="button" role="radio" aria-checked={mode === "own"} className={`button compact${mode === "own" ? " primary" : ""}`} onClick={() => onMode("own")}>
        {t("Eigener Bot", "Own bot")}
      </button>
    </div>
  );
}

// The deep link with its one-time code; the list is asked again every few
// seconds until the chat is bound (or the code expires).
function TelegramBotLink({ onLinked, onCancel }: { onLinked: (next: MessengerOverview) => void; onCancel: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [link, setLink] = useState<TelegramLink | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  const linkedRef = useRef(onLinked);
  linkedRef.current = onLinked;
  const create = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setLink(await api<TelegramLink>("/api/messengers", { action: "link" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!link || linked) return;
    const timer = setInterval(async () => {
      if (Date.now() > link.expires) return clearInterval(timer);
      try {
        const next = await api<MessengerOverview>("/api/messengers");
        // The form is only offered while no chat is bound to the bot.
        if (next.targets.some((target) => target.service === "telegram" && target.mode === "bot")) {
          setLinked(true);
          clearInterval(timer);
          linkedRef.current(next);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(timer);
  }, [link, linked]);
  if (linked)
    return (
      <p className="messenger-note" data-tone="ok" role="status">
        {t("Verbunden – Telegram bekommt ab jetzt deine Benachrichtigungen.", "Connected – Telegram now gets your notifications.")}
      </p>
    );
  return (
    <>
      <p className="messenger-note">
        {t(
          "Erzeuge einen Link, öffne ihn auf dem Gerät mit Telegram und tippe auf „Starten“. Der Code gilt 15 Minuten und nur einmal.",
          "Create a link, open it on the device with Telegram and tap “Start”. The code is valid for 15 minutes and only once.",
        )}
      </p>
      {link && (
        <div className="messenger-link">
          <a className="button primary" href={link.url} target="_blank" rel="noreferrer">
            <ArrowSquareOut size={15} aria-hidden /> {t(`@${link.username} in Telegram öffnen`, `Open @${link.username} in Telegram`)}
          </a>
          <small className="muted">
            {t("Oder sende dem Bot:", "Or send the bot:")} <code>/start {link.code}</code>
          </small>
          <small className="muted" role="status">
            {t(
              `Wartet auf Telegram … gültig bis ${new Date(link.expires).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`,
              `Waiting for Telegram … valid until ${new Date(link.expires).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`,
            )}
          </small>
        </div>
      )}
      {error && (
        <p className="messenger-note" data-tone="error" role="alert">
          {error}
        </p>
      )}
      <div className="messenger-actions">
        <button type="button" className="button" disabled={busy} aria-busy={busy} onClick={() => void create()}>
          {link ? t("Neuen Link erzeugen", "Create a new link") : t("Verbindungslink erzeugen", "Create a connection link")}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          {t("Abbrechen", "Cancel")}
        </button>
      </div>
    </>
  );
}
