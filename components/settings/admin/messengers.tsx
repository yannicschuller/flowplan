"use client";
// Administration → Chat-Apps (lib/messengers.ts, /api/admin/messengers):
// which chat apps people may connect for notifications, the instance's
// Telegram bot (token checked with getMe, stored sealed, shown as "…abcd"),
// which server addresses people may use, and the deliveries of 24 hours.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { messengerErrorText, messengerNames, messengerServices, TELEGRAM_API, type MessengerAdminStatus, type MessengerService } from "@/lib/messenger-services";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { SaveState, SettingGroup, SettingRow, StatusBadge, Switch, useSaveState } from "../../settings-ui";
import { useAdmin } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, useDocs, type StatusItem } from "./parts";

export default function MessengersSection() {
  const t = useT();
  const docs = useDocs();
  const { onError } = useAdmin();
  const [status, setStatus] = useState<MessengerAdminStatus | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const load = useCallback(async () => {
    try {
      setStatus(await api<MessengerAdminStatus>("/api/admin/messengers"));
    } catch (e) {
      errorRef.current((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const [saveState, run] = useSaveState();
  const [token, setToken] = useState("");
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const [botState, runBot] = useSaveState();
  const [hosts, setHosts] = useState<string | null>(null);
  const [hostState, runHosts] = useSaveState();
  if (!status) return <AdminLoading />;

  const post = async (body: Record<string, unknown>) => setStatus(await api<MessengerAdminStatus>("/api/admin/messengers", body));
  const allowed = messengerServices.filter((s) => status.services[s]);
  const active = messengerServices.reduce((n, s) => n + status.targets[s].active, 0);
  const disabled = messengerServices.reduce((n, s) => n + status.targets[s].disabled, 0);
  const d = status.deliveries;
  const bot = status.bot;
  const items: StatusItem[] = [
    allowed.length
      ? { tone: "ok", label: t(`${allowed.length} von 4 Diensten erlaubt`, `${allowed.length} of 4 services allowed`) }
      : { tone: "off", label: t("Chat-Apps aus", "Chat apps off") },
  ];
  if (status.services.telegram)
    items.push(
      bot.configured && bot.username
        ? { tone: bot.lastError ? "warn" : "ok", label: t(`Telegram-Bot @${bot.username}`, `Telegram bot @${bot.username}`) }
        : bot.lastError === "sealed"
          ? { tone: "error", label: t("Bot-Token nicht lesbar", "Bot token not readable") }
          : { tone: "info", label: t("Kein Telegram-Bot der Instanz", "No instance Telegram bot") },
    );
  if (d.failed) items.push({ tone: "error", label: t(`${d.failed} aufgegeben (24 h)`, `${d.failed} given up (24 h)`) });
  if (d.pending) items.push({ tone: "info", label: t(`${d.pending} in der Warteschlange`, `${d.pending} queued`) });
  const guide = docs("search-and-notifications", "chat-apps", "chat-apps");

  const saveBot = (e: FormEvent) => {
    e.preventDefault();
    void runBot(async () => {
      await post({ action: "bot", ...(token.trim() ? { token: token.trim() } : {}), apiUrl: (apiUrl ?? bot.apiUrl).trim() || TELEGRAM_API });
      setToken("");
      setApiUrl(null);
    });
  };
  const hostText = hosts ?? status.allowedHosts.join("\n");

  return (
    <>
      <AdminStatus items={items} action={<FixLink href={guide}>{t("Anleitung", "Guide")}</FixLink>}>
        {t(
          `${active} Verbindungen aktiv${disabled ? `, ${disabled} nach Fehlern ausgeschaltet` : ""} · ${d.delivered} Nachrichten in 24 Stunden zugestellt.`,
          `${active} connections active${disabled ? `, ${disabled} switched off after errors` : ""} · ${d.delivered} messages delivered in 24 hours.`,
        )}
        {d.lastError ? ` ${t("Letzter Fehler:", "Last error:")} ${messengerErrorText(d.lastError, t)}` : ""}
      </AdminStatus>

      <SettingGroup
        id="services"
        title={t("Erlaubte Dienste", "Allowed services")}
        description={t(
          "Was Personen unter Einstellungen → Benachrichtigungen verbinden dürfen. Ausgeschaltete Dienste bekommen keine Nachrichten mehr; die Verbindungen bleiben gespeichert.",
          "What people may connect under Settings → Notifications. Services switched off get no more messages; the connections stay stored.",
        )}
        actions={<SaveState status={saveState} />}
      >
        {messengerServices.map((service: MessengerService) => (
          <SettingRow
            key={service}
            label={messengerNames[service]}
            description={t(
              `${status.targets[service].active} aktiv · ${status.targets[service].disabled} ausgeschaltet`,
              `${status.targets[service].active} active · ${status.targets[service].disabled} switched off`,
            )}
          >
            <Switch
              label={messengerNames[service]}
              checked={status.services[service]}
              disabled={saveState.state === "saving"}
              onChange={(on) => void run(() => post({ action: "save", services: { [service]: on } }))}
            />
          </SettingRow>
        ))}
        {status.servicesFromEnv && (
          <p className="messenger-form messenger-note">{t("Vorgabe aus FLOWPLAN_MESSENGERS, bis hier gespeichert wird.", "Default from FLOWPLAN_MESSENGERS until saved here.")}</p>
        )}
      </SettingGroup>

      <SettingGroup
        id="bot"
        title={t("Telegram-Bot der Instanz", "Instance Telegram bot")}
        description={t(
          "Mit einem Bot der Instanz verbinden Personen Telegram mit einem Link und einem Einmal-Code – ohne eigenen Bot. Flowplan fragt die Nachrichten des Bots nur ab, während ein Code wartet (getUpdates); eine öffentliche Adresse ist nicht nötig. Lege den Bot bei @BotFather an.",
          "With a bot of the instance people connect Telegram with a link and a one-time code – without an own bot. Flowplan only asks for the bot's messages while a code waits (getUpdates); no public address is needed. Create the bot with @BotFather.",
        )}
        actions={<SaveState status={botState} />}
      >
        {bot.configured && (
          <SettingRow
            label={t("Bot", "Bot")}
            description={
              bot.source === "env"
                ? t("Aus FLOWPLAN_TELEGRAM_BOT_TOKEN – ein hier gespeicherter Token hat Vorrang.", "From FLOWPLAN_TELEGRAM_BOT_TOKEN – a token saved here takes precedence.")
                : t(`Token gespeichert (${bot.tokenHint}), verschlüsselt.`, `Token stored (${bot.tokenHint}), encrypted.`)
            }
          >
            <StatusBadge tone={bot.lastError && bot.lastError !== "sealed" ? "warn" : "ok"}>{bot.username ? `@${bot.username}` : t("Name unbekannt", "Name unknown")}</StatusBadge>
          </SettingRow>
        )}
        {bot.lastError && (
          <SettingRow
            label={t("Letzter Fehler", "Last error")}
            description={
              bot.lastError === "sealed"
                ? t("Der gespeicherte Token wurde mit einem anderen Schlüssel verschlüsselt (z. B. nach einer Wiederherstellung). Bitte neu eingeben.", "The stored token was encrypted with another key (e.g. after a restore). Please enter it again.")
                : bot.lastError === "conflict"
                  ? t("Telegram meldet einen Konflikt: Für den Bot ist ein Webhook gesetzt oder ein anderes Programm fragt ihn ab. Nutze einen eigenen Bot für Flowplan.", "Telegram reports a conflict: a webhook is set for the bot or another program polls it. Use a separate bot for Flowplan.")
                  : messengerErrorText(bot.lastError, t)
            }
          >
            <StatusBadge tone="error">{t("Fehler", "Error")}</StatusBadge>
          </SettingRow>
        )}
        <form method="post" action="/api/auth/no-script" className="messenger-form" onSubmit={saveBot} aria-label={t("Telegram-Bot der Instanz", "Instance Telegram bot")}>
          <label>
            {t("Bot-Token", "Bot token")}
            <input type="password" autoComplete="off" placeholder={bot.source === "stored" ? t(`leer lassen: bleibt ${bot.tokenHint}`, `leave empty: keeps ${bot.tokenHint}`) : "123456:ABC…"} value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <label>
            {t("API-Adresse", "API address")}
            <input type="url" placeholder={TELEGRAM_API} value={apiUrl ?? (bot.apiUrlDefault ? "" : bot.apiUrl)} onChange={(e) => setApiUrl(e.target.value)} />
            <small>{t("Leer: api.telegram.org. Sonst ein eigener Bot-API-Server oder ein Relay/Proxy (auch im eigenen Netz).", "Empty: api.telegram.org. Otherwise an own Bot API server or a relay/proxy (also in the own network).")}</small>
          </label>
          <div className="messenger-actions">
            <button className="button primary" disabled={botState.state === "saving" || (!token.trim() && bot.source !== "stored")}>
              {t("Prüfen und speichern", "Check and save")}
            </button>
            {bot.source === "stored" && (
              <button type="button" className="button" disabled={botState.state === "saving"} onClick={() => void runBot(() => post({ action: "bot.remove" }))}>
                {t("Bot entfernen", "Remove bot")}
              </button>
            )}
          </div>
        </form>
      </SettingGroup>

      <SettingGroup
        id="hosts"
        title={t("Server-Adressen", "Server addresses")}
        description={t(
          "Leer: Personen dürfen jeden öffentlichen Server für Gotify, ntfy, Matrix und eigene Telegram-Bots angeben. Sonst nur diese Hosts, einer pro Zeile (*.example.org für Subdomains); api.telegram.org und ntfy.sh gehen immer.",
          "Empty: people may name any public server for Gotify, ntfy, Matrix and own Telegram bots. Otherwise only these hosts, one per line (*.example.org for subdomains); api.telegram.org and ntfy.sh always work.",
        )}
        actions={<SaveState status={hostState} />}
      >
        <SettingRow
          label={t("Interne Adressen", "Internal addresses")}
          description={t(
            "Server im eigenen Netz erlaubt FLOWPLAN_MESSENGER_ALLOW_PRIVATE=true (sonst gilt FLOWPLAN_WEBHOOK_ALLOW_PRIVATE).",
            "FLOWPLAN_MESSENGER_ALLOW_PRIVATE=true allows servers in the own network (otherwise FLOWPLAN_WEBHOOK_ALLOW_PRIVATE applies).",
          )}
        >
          <StatusBadge tone={status.allowPrivate ? "warn" : "ok"}>{status.allowPrivate ? t("erlaubt", "allowed") : t("gesperrt", "blocked")}</StatusBadge>
        </SettingRow>
        <form
          className="messenger-form"
          onSubmit={(e) => {
            e.preventDefault();
            void runHosts(async () => {
              await post({ action: "save", allowedHosts: hostText.split(/[\s,]+/).filter(Boolean) });
              setHosts(null);
            });
          }}
        >
          <label>
            {t("Erlaubte Hosts", "Allowed hosts")}
            <textarea className="messenger-hosts" placeholder={"ntfy.example.org\n*.example.org"} value={hostText} onChange={(e) => setHosts(e.target.value)} />
          </label>
          <div className="messenger-actions">
            <button className="button" disabled={hostState.state === "saving" || hosts === null}>
              {t("Speichern", "Save")}
            </button>
          </div>
        </form>
      </SettingGroup>
    </>
  );
}
