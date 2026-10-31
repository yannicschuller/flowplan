// Chat apps that receive notifications (#63): what the settings and the
// administration show about them – client-safe, no secrets. The sending,
// storage and queue live in lib/messengers.ts.
export const messengerServices = ["telegram", "gotify", "ntfy", "matrix"] as const;
export type MessengerService = (typeof messengerServices)[number];
export const isMessengerService = (value: unknown): value is MessengerService =>
  typeof value === "string" && (messengerServices as readonly string[]).includes(value);

export const messengerNames: Record<MessengerService, string> = {
  telegram: "Telegram",
  gotify: "Gotify",
  ntfy: "ntfy",
  matrix: "Matrix",
};

// The public servers a service uses when nobody names another one. They
// are never "custom" addresses, so a restriction of server addresses by
// the administrators does not apply to them.
export const TELEGRAM_API = "https://api.telegram.org";
export const NTFY_DEFAULT = "https://ntfy.sh";

// One connection as the browser sees it: where messages go, never a token.
// `secretHint` is "…" plus the last four characters, or "" for no secret.
export type MessengerTarget = {
  id: string;
  service: MessengerService;
  // Telegram: "bot" (the instance's bot, bound with a one-time code) or
  // "own" (the person's own bot token and chat id); "" for the others.
  mode: "" | "bot" | "own";
  // Server address, topic, room or chat – nothing secret.
  detail: string;
  secretHint: string;
  hasSecret: boolean;
  enabled: boolean;
  // Why the instance turned it off (repeated 401/404), shown to the person.
  disabledReason: string | null;
  lastError: string | null;
  lastOkAt: number | null;
  // The instance forbids this service now: nothing is sent.
  blocked: boolean;
};

export type MessengerOverview = {
  // Services the instance allows (Administration → Chat-Apps).
  services: MessengerService[];
  // The instance's Telegram bot, when one is set up: its @name.
  bot: { username: string } | null;
  // Only some server addresses are allowed (empty: any public one).
  allowedHosts: string[];
  // Text and excerpt (true) or only "new notification" with the link.
  preview: boolean;
  // Administrators: operations alerts (backup, storage, workers, sign-ins).
  ops: boolean;
  admin: boolean;
  targets: MessengerTarget[];
};

// A binding of a Telegram chat to the instance's bot, while it waits.
export type TelegramLink = { url: string; code: string; expires: number; username: string };

// The administration's view (app/api/admin/messengers).
export type MessengerAdminStatus = {
  services: Record<MessengerService, boolean>;
  // Set by FLOWPLAN_MESSENGERS (the default until saved here).
  servicesFromEnv: boolean;
  allowedHosts: string[];
  allowPrivate: boolean;
  bot: {
    configured: boolean;
    // "env": FLOWPLAN_TELEGRAM_BOT_TOKEN; "stored": saved here.
    source: "env" | "stored" | null;
    tokenHint: string;
    apiUrl: string;
    apiUrlDefault: boolean;
    username: string | null;
    // getUpdates while someone is connecting; the last error of it.
    lastError: string | null;
    lastPollAt: number | null;
  };
  targets: Record<MessengerService, { active: number; disabled: number }>;
  deliveries: { delivered: number; failed: number; pending: number; lastError: string | null };
};

// Why a message did not arrive, as stored with a connection ("auth:401",
// "notfound:404", "private", "unreachable", "rate_limited", "server:502",
// "rejected:400") – never the answer's text, which may repeat a token.
export type MessengerFailure = "auth" | "notfound" | "private" | "unreachable" | "rate_limited" | "server" | "rejected";
export function messengerErrorText(code: string | null | undefined, say: (de: string, en: string) => string) {
  if (!code) return "";
  const [reason, status] = code.split(":");
  const http = status ? ` (HTTP ${status})` : "";
  switch (reason as MessengerFailure) {
    case "auth":
      return say(`Zugangsdaten abgelehnt${http} – prüfe den Token.`, `Credentials refused${http} – check the token.`);
    case "notfound":
      return say(`Nicht gefunden${http} – prüfe Adresse, Thema, Raum oder Chat-ID.`, `Not found${http} – check the address, topic, room or chat ID.`);
    case "private":
      return say("Interne Adressen sind für Chat-Apps gesperrt.", "Internal addresses are blocked for chat apps.");
    case "unreachable":
      return say("Server nicht erreichbar.", "Server not reachable.");
    case "rate_limited":
      return say("Zu viele Nachrichten – der Dienst bremst, es wird später erneut versucht.", "Too many messages – the service is throttling, it is retried later.");
    case "server":
      return say(`Der Dienst hat einen Fehler gemeldet${http}.`, `The service reported an error${http}.`);
    case "rejected":
      return say(`Der Dienst hat die Nachricht abgelehnt${http}.`, `The service refused the message${http}.`);
    default:
      return code;
  }
}
