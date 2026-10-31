// Notifications to chat apps (#63): Telegram, Gotify, ntfy and Matrix next
// to push and e-mail. Each person connects at most one target per service
// (Settings → Benachrichtigungen → Chat-Apps) and switches the channel per
// kind of notification in the same matrix as push and e-mail
// (lib/notification-kinds.ts). Every notification that reaches the inbox
// is queued per connected target by a trigger (lib/db.ts, schema 79) and
// sent by a worker, like push: retried with a growing pause, given up after
// MAX_ATTEMPTS, at most RATE_PER_MINUTE messages a minute per target, and a
// target that is refused (401/403/404, internal address) DISABLE_AFTER times
// in a row is turned off – the person learns it in the inbox.
//
// What a message says: like push, the notification's text (shortened) and
// the link; per person only "Neue Benachrichtigung in Flowplan" with the
// link; always only that for pages of end-to-end encrypted spaces. Never a
// token or other secret.
//
// Telegram works two ways: the instance's bot (Administration → Chat-Apps,
// or FLOWPLAN_TELEGRAM_BOT_TOKEN / FLOWPLAN_TELEGRAM_API_URL) with a one-time
// code in a t.me deep link – the worker reads the bot's updates with
// getUpdates long polling while a code waits, so no public address is
// needed – or a person's own bot token and chat id. A custom Bot API
// address serves self-hosted Bot API servers and relays.
//
// Secrets (bot, app and access tokens, passwords) are sealed like the other
// stored secrets (lib/ai/secrets.ts, bound to their connection) and never
// leave the server: the browser sees "…" plus the last four characters.
// Outgoing requests go through lib/safe-fetch.ts; internal addresses are
// refused unless FLOWPLAN_MESSENGER_ALLOW_PRIVATE=true (by default the value
// of FLOWPLAN_WEBHOOK_ALLOW_PRIVATE). Administrators can switch each service
// off and restrict the server addresses people may use.
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { all, audit, id, one, run } from "./db";
import { adminUserIds, HttpError } from "./auth";
import { ct } from "./content-locale";
import { translate, type Locale } from "./i18n";
import { localizedMessage } from "./i18n-errors";
import { userLocale } from "./user-locale";
import { openSecret, sealSecret, keyHint } from "./ai/secrets";
import { privateAddress } from "./safe-fetch";
import { securityEvent } from "./security-events";
import { notificationUrl } from "./page-location";
import { pageRole } from "./permissions";
import { isEncryptedPage } from "./e2ee-server";
import { instanceSettings } from "./instance-settings";
import type { NotificationKind } from "./notification-kinds";
import type { Identity, Page } from "./types";
import {
  messengerNames,
  messengerServices,
  NTFY_DEFAULT,
  TELEGRAM_API,
  type MessengerAdminStatus,
  type MessengerOverview,
  type MessengerService,
  type MessengerTarget,
  type TelegramLink,
} from "./messenger-services";
import {
  defaultHttp,
  failureCode,
  sendMessage,
  telegramMethodUrl,
  type MessengerConfig,
  type MessengerHttp,
  type MessengerMessage,
  type MessengerSecrets,
  type SendOutcome,
} from "./messenger-send";

export const MAX_ATTEMPTS = 6;
export const DISABLE_AFTER = 3;
export const RATE_PER_MINUTE = 20;
export const LINK_MINUTES = 15;
const TEST_PER_MINUTE = 5;
const DAY = 86_400_000;

const runtime = globalThis as unknown as {
  flowplanMessengerHttp?: MessengerHttp;
  flowplanMessengerResolve?: (host: string) => Promise<string[]>;
  flowplanMessengerRun?: Promise<void>;
  flowplanMessengerTimer?: ReturnType<typeof setInterval>;
  flowplanTelegramPoll?: Promise<void>;
  flowplanMessengerTests?: Map<string, number[]>;
};

// Tests replace the network: the HTTP transport and the DNS lookup.
export function setMessengerHttp(http: MessengerHttp | undefined) {
  runtime.flowplanMessengerHttp = http;
}
export function setMessengerResolver(resolve: ((host: string) => Promise<string[]>) | undefined) {
  runtime.flowplanMessengerResolve = resolve;
}
const http = (): MessengerHttp => runtime.flowplanMessengerHttp ?? defaultHttp;
const resolveHost = (host: string) =>
  runtime.flowplanMessengerResolve ? runtime.flowplanMessengerResolve(host) : lookup(host, { all: true }).then((list) => list.map((a) => a.address));

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const instanceName = () => instanceSettings().name || "Flowplan";

/* ---------- Instance configuration ---------- */

type StoredConfig = {
  services?: Partial<Record<MessengerService, boolean>>;
  allowedHosts?: string[];
  // Sealed bot token (aad "messenger-bot"), its API address and @name.
  bot?: { token: string; apiUrl?: string; username?: string } | null;
};
const CONFIG_KEY = "messengers";
function readStored(): StoredConfig {
  const row = one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", CONFIG_KEY);
  try {
    return row ? (JSON.parse(row.value) as StoredConfig) : {};
  } catch {
    return {};
  }
}
function writeStored(config: StoredConfig) {
  run(
    "INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    CONFIG_KEY,
    JSON.stringify(config),
  );
}
const state = (key: string) => one<{ value: string }>("SELECT value FROM instance_state WHERE key=?", key)?.value ?? null;
const setState = (key: string, value: string | null) =>
  value === null
    ? run("DELETE FROM instance_state WHERE key=?", key)
    : run("INSERT INTO instance_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);

// Internal addresses (Gotify or ntfy in the own network): only when the
// operator allows them, like webhooks.
export function messengerAllowPrivate() {
  const own = process.env.FLOWPLAN_MESSENGER_ALLOW_PRIVATE?.trim();
  return (own || process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE) === "true";
}

// FLOWPLAN_MESSENGERS: the services allowed until an administrator saves
// them ("telegram,ntfy"; "off" for none; unset for all).
function envServices(): Record<MessengerService, boolean> | null {
  const raw = process.env.FLOWPLAN_MESSENGERS?.trim().toLowerCase();
  if (!raw) return null;
  const listed = raw === "off" || raw === "none" ? [] : raw.split(/[\s,]+/);
  return Object.fromEntries(messengerServices.map((s) => [s, listed.includes(s)])) as Record<MessengerService, boolean>;
}

type Bot = { token: string; apiUrl: string; username: string | null; source: "env" | "stored" };
export function messengerConfig() {
  const stored = readStored();
  const env = envServices();
  const services = Object.fromEntries(
    messengerServices.map((s) => [s, stored.services?.[s] ?? env?.[s] ?? true]),
  ) as Record<MessengerService, boolean>;
  let bot: Bot | null = null;
  let botError: string | null = null;
  if (stored.bot?.token) {
    try {
      bot = {
        token: openSecret(stored.bot.token, "messenger-bot"),
        apiUrl: stored.bot.apiUrl || TELEGRAM_API,
        username: stored.bot.username || null,
        source: "stored",
      };
    } catch {
      // Sealed with a key this instance does not have (a restored backup).
      botError = "sealed";
    }
  } else if (process.env.FLOWPLAN_TELEGRAM_BOT_TOKEN?.trim()) {
    const token = process.env.FLOWPLAN_TELEGRAM_BOT_TOKEN.trim();
    const known = state("telegramBot");
    let username: string | null = null;
    try {
      const parsed = known ? (JSON.parse(known) as { hash: string; username: string }) : null;
      if (parsed?.hash === tokenHash(token)) username = parsed.username;
    } catch {}
    bot = { token, apiUrl: (process.env.FLOWPLAN_TELEGRAM_API_URL?.trim() || TELEGRAM_API).replace(/\/+$/, ""), username, source: "env" };
  }
  return {
    services,
    servicesFromEnv: !stored.services && !!env,
    allowedHosts: stored.allowedHosts ?? [],
    bot,
    botError,
  };
}
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);
const serviceAllowed = (service: MessengerService) => messengerConfig().services[service];

/* ---------- Server addresses ---------- */

// Whether a host may be used under the administrators' restriction
// ("ntfy.example.org", "*.example.org"); the default servers always may.
export function hostAllowed(host: string, allowedHosts: string[], defaults: string[] = []) {
  const h = host.toLowerCase();
  if (!allowedHosts.length || defaults.includes(h)) return true;
  return allowedHosts.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.startsWith("*.") ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e;
  });
}

// A base address a person entered: https (http only where internal
// addresses are allowed), no credentials, query or fragment, an allowed
// host that does not resolve to an internal address.
export async function checkServerUrl(raw: string, defaults: string[] = []): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, ct("Ungültige Server-Adresse.", "Invalid server address."));
  }
  const allowPrivate = messengerAllowPrivate();
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:"))
    throw new HttpError(400, ct("Die Server-Adresse muss mit https:// beginnen.", "The server address must start with https://."));
  if (url.username || url.password || url.search || url.hash)
    throw new HttpError(400, ct("Zugangsdaten und Parameter gehören nicht in die Server-Adresse.", "Credentials and parameters do not belong in the server address."));
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostAllowed(host, messengerConfig().allowedHosts, defaults))
    throw new HttpError(400, ct(`Server „${host}“ ist auf dieser Instanz nicht freigegeben.`, `Server “${host}” is not allowed on this instance.`));
  if (!allowPrivate) {
    const addresses = isIP(host) ? [host] : await resolveHost(host).catch(() => []);
    if (!addresses.length) throw new HttpError(400, ct(`Server „${host}“ wurde nicht gefunden.`, `Server “${host}” was not found.`));
    if (addresses.some(privateAddress)) {
      securityEvent("blocked.ssrf", { detail: `messenger ${host}` });
      throw new HttpError(400, ct("Interne Adressen sind für Chat-Apps gesperrt.", "Internal addresses are blocked for chat apps."));
    }
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/* ---------- Connections of a person ---------- */

type TargetRow = {
  id: string;
  user_id: string;
  service: MessengerService;
  mode: "" | "bot" | "own";
  config: string;
  secret: string | null;
  secret_hint: string;
  enabled: number;
  disabled_reason: string | null;
  failures: number;
  last_error: string | null;
  last_ok_at: number | null;
};
const sealedFor = (targetId: string) => `messenger:${targetId}`;
function openTargetSecrets(target: Pick<TargetRow, "id" | "secret">): MessengerSecrets {
  if (!target.secret) return {};
  try {
    return JSON.parse(openSecret(target.secret, sealedFor(target.id))) as MessengerSecrets;
  } catch {
    return {};
  }
}
const parseConfig = (raw: string): MessengerConfig => {
  try {
    return JSON.parse(raw || "{}") as MessengerConfig;
  } catch {
    return {};
  }
};
const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};
// Where messages go, for the list – never a token.
function targetDetail(t: TargetRow, bot: Bot | null): string {
  const c = parseConfig(t.config);
  switch (t.service) {
    case "telegram":
      return t.mode === "bot"
        ? `${bot?.username ? `@${bot.username}` : "Bot"} · Chat ${c.chatId}`
        : `Chat ${c.chatId}${c.apiUrl && c.apiUrl !== TELEGRAM_API ? ` · ${hostOf(c.apiUrl)}` : ""}`;
    case "gotify":
      return hostOf(c.server);
    case "ntfy":
      return `${hostOf(c.server)}/${c.topic}${c.user ? ` · ${c.user}` : ""}`;
    case "matrix":
      return `${c.room} · ${hostOf(c.homeserver)}`;
  }
}
function targetView(t: TargetRow, config: ReturnType<typeof messengerConfig>): MessengerTarget {
  return {
    id: t.id,
    service: t.service,
    mode: t.mode,
    detail: targetDetail(t, config.bot),
    secretHint: t.secret_hint,
    hasSecret: !!t.secret,
    enabled: !!t.enabled,
    disabledReason: t.disabled_reason,
    lastError: t.last_error,
    lastOkAt: t.last_ok_at,
    blocked: !config.services[t.service] || (t.mode === "bot" && !config.bot),
  };
}

function personalSettings(userId: string) {
  const row = one<{ preview: number; ops: number }>("SELECT preview,ops FROM messenger_settings WHERE user_id=?", userId);
  return { preview: row ? !!row.preview : true, ops: row ? !!row.ops : true };
}

export function messengerOverview(user: Identity): MessengerOverview {
  const config = messengerConfig();
  const settings = personalSettings(user.id);
  return {
    services: messengerServices.filter((s) => config.services[s]),
    bot: config.bot && config.services.telegram ? { username: config.bot.username || "" } : null,
    allowedHosts: config.allowedHosts,
    preview: settings.preview,
    ops: settings.ops,
    admin: !!user.isAdmin,
    targets: all<TargetRow>("SELECT * FROM messenger_targets WHERE user_id=? ORDER BY created_at", user.id).map((t) => targetView(t, config)),
  };
}

function requireBrowserUser(user: Identity) {
  if (user.apiScope) throw new HttpError(403, ct("Mit einem API-Token nicht möglich.", "Not possible with an API token."));
  if (user.demo) throw new HttpError(403, ct("In der Demo nicht verfügbar.", "Not available in the demo."));
}

const secretText = z.string().trim().max(500).regex(/^\S*$/, "Ohne Leerzeichen.");
const connectInput = z.discriminatedUnion("service", [
  z.object({
    service: z.literal("telegram"),
    // The instance's bot is bound with a code (createTelegramLink).
    token: secretText.optional(),
    chatId: z.string().trim().regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/),
    apiUrl: z.string().trim().max(500).optional(),
  }),
  z.object({ service: z.literal("gotify"), server: z.string().trim().min(1).max(500), token: secretText.optional() }),
  z.object({
    service: z.literal("ntfy"),
    server: z.string().trim().max(500).optional(),
    topic: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/),
    auth: z.enum(["none", "token", "basic"]).default("none"),
    token: secretText.optional(),
    user: z.string().trim().max(100).optional(),
    password: z.string().max(200).optional(),
  }),
  z.object({
    service: z.literal("matrix"),
    homeserver: z.string().trim().min(1).max(500),
    room: z.string().trim().max(255).regex(/^![^:\s]+:\S+$/),
    token: secretText.optional(),
  }),
]);

const TELEGRAM_TOKEN = /^\d{3,15}:[A-Za-z0-9_-]{20,100}$/;

// Connects or changes the person's target of a service. Secret fields left
// empty keep what is stored (changing the topic needs no new token).
export async function connectMessenger(user: Identity, input: unknown) {
  requireBrowserUser(user);
  const b = connectInput.parse(input);
  if (!serviceAllowed(b.service))
    throw new HttpError(403, ct(`${messengerNames[b.service]} ist auf dieser Instanz ausgeschaltet.`, `${messengerNames[b.service]} is switched off on this instance.`));
  const existing = one<TargetRow>("SELECT * FROM messenger_targets WHERE user_id=? AND service=?", user.id, b.service);
  const previous = existing ? openTargetSecrets(existing) : {};
  const previousConfig = existing ? parseConfig(existing.config) : {};
  let config: MessengerConfig;
  const secrets: MessengerSecrets = {};
  const need = (value: string | undefined, label: [string, string]) => {
    if (!value) throw new HttpError(400, ct(`${label[0]} fehlt.`, `${label[1]} is missing.`));
    return value;
  };
  switch (b.service) {
    case "telegram": {
      const apiUrl = b.apiUrl ? await checkServerUrl(b.apiUrl, ["api.telegram.org"]) : TELEGRAM_API;
      secrets.token = need(b.token || (existing?.mode === "own" ? previous.token : undefined), ["Bot-Token", "Bot token"]);
      if (!TELEGRAM_TOKEN.test(secrets.token)) throw new HttpError(400, ct("Das sieht nicht wie ein Bot-Token aus (123456:ABC…).", "That does not look like a bot token (123456:ABC…)."));
      config = { apiUrl, chatId: b.chatId };
      break;
    }
    case "gotify":
      config = { server: await checkServerUrl(b.server) };
      secrets.token = need(b.token || (previousConfig.server === config.server ? previous.token : undefined), ["App-Token", "App token"]);
      break;
    case "ntfy": {
      const server = await checkServerUrl(b.server || NTFY_DEFAULT, ["ntfy.sh"]);
      config = { server, topic: b.topic };
      const same = previousConfig.server === server;
      if (b.auth === "token") secrets.token = need(b.token || (same ? previous.token : undefined), ["Zugriffstoken", "Access token"]);
      if (b.auth === "basic") {
        config.user = need(b.user, ["Benutzername", "User name"]);
        secrets.password = need(b.password || (same && previousConfig.user === b.user ? previous.password : undefined), ["Passwort", "Password"]);
      }
      break;
    }
    case "matrix":
      config = { homeserver: await checkServerUrl(b.homeserver), room: b.room };
      secrets.token = need(b.token || (previousConfig.homeserver === config.homeserver ? previous.token : undefined), ["Zugriffstoken", "Access token"]);
      break;
  }
  const targetId = existing?.id ?? id();
  const sealed = Object.keys(secrets).length ? sealSecret(JSON.stringify(secrets), sealedFor(targetId)) : null;
  const hint = secrets.token ? (keyHint(secrets.token) ? `…${keyHint(secrets.token)}` : "") : "";
  saveTarget(user.id, targetId, b.service, b.service === "telegram" ? "own" : "", config, sealed, hint, !!existing);
  return messengerOverview(user);
}

function saveTarget(userId: string, targetId: string, service: MessengerService, mode: string, config: MessengerConfig, sealed: string | null, hint: string, existed: boolean) {
  run(
    `INSERT INTO messenger_targets(id,user_id,service,mode,config,secret,secret_hint,enabled,failures,created_at) VALUES(?,?,?,?,?,?,?,1,0,?)
     ON CONFLICT(user_id,service) DO UPDATE SET mode=excluded.mode,config=excluded.config,secret=excluded.secret,secret_hint=excluded.secret_hint,
       enabled=1,disabled_reason=NULL,failures=0,last_error=NULL`,
    targetId,
    userId,
    service,
    mode,
    JSON.stringify(config),
    sealed,
    hint,
    Date.now(),
  );
  // Where it goes (host, never a token) for the person's security log.
  const where = config.server || config.homeserver || (mode === "bot" ? "bot" : config.apiUrl) || "";
  securityEvent("account.messenger_added", { actorId: userId, detail: `${service}${existed ? " (changed)" : ""} ${hostOf(where) || where}`.trim() });
  audit(userId, "messenger.connect", targetId, service);
}

export function removeMessenger(user: Identity, input: unknown) {
  requireBrowserUser(user);
  const targetId = z.string().max(60).parse((input as { id?: unknown })?.id);
  const target = one<TargetRow>("SELECT * FROM messenger_targets WHERE id=? AND user_id=?", targetId, user.id);
  if (!target) throw new HttpError(404, ct("Verbindung nicht gefunden.", "Connection not found."));
  run("DELETE FROM messenger_targets WHERE id=?", target.id);
  securityEvent("account.messenger_removed", { actorId: user.id, detail: target.service });
  audit(user.id, "messenger.remove", target.id, target.service);
  return messengerOverview(user);
}

// Turned off after repeated refusals: on again (counting starts anew).
export function enableMessenger(user: Identity, input: unknown) {
  requireBrowserUser(user);
  const targetId = z.string().max(60).parse((input as { id?: unknown })?.id);
  if (!run("UPDATE messenger_targets SET enabled=1,disabled_reason=NULL,failures=0 WHERE id=? AND user_id=?", targetId, user.id).changes)
    throw new HttpError(404, ct("Verbindung nicht gefunden.", "Connection not found."));
  return messengerOverview(user);
}

export function setMessengerSettings(user: Identity, input: unknown) {
  requireBrowserUser(user);
  const b = z.object({ preview: z.boolean().optional(), ops: z.boolean().optional() }).parse(input);
  const current = personalSettings(user.id);
  run(
    "INSERT INTO messenger_settings(user_id,preview,ops) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET preview=excluded.preview,ops=excluded.ops",
    user.id,
    (b.preview ?? current.preview) ? 1 : 0,
    (b.ops ?? current.ops) ? 1 : 0,
  );
  return messengerOverview(user);
}

/* ---------- Messages ---------- */

// i18n-table: 1 – short names of the kinds in a message's title
const kindTitles: Record<NotificationKind, [string, string]> = {
  mention: ["Erwähnung", "Mention"],
  share: ["Geteilt", "Shared"],
  comment: ["Kommentar", "Comment"],
  reminder: ["Erinnerung", "Reminder"],
  guest: ["Gast", "Guest"],
  change: ["Änderung", "Change"],
  automation: ["Automation", "Automation"],
  security: ["Sicherheit", "Security"],
};
const excerpt = (text: string, max = 280) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

// The message for one notification: its text, or only a hint when the
// person wants that or the page is end-to-end encrypted.
export function notificationMessage(
  notification: { id?: string; body: string | null; kind: string | null; page_id: string | null; row_id?: string | null; thread_id?: string | null },
  locale: Locale,
  options: { preview: boolean; encrypted: boolean },
): MessengerMessage {
  const say = translate(locale);
  const url = `${appUrl()}${notificationUrl(notification)}`;
  const open = say("In Flowplan öffnen", "Open in Flowplan");
  const kind = (notification.kind || "comment") as NotificationKind;
  const urgent = kind === "security";
  if (!options.preview || options.encrypted || !notification.body)
    return { title: instanceName(), text: say("Neue Benachrichtigung in Flowplan", "New notification in Flowplan"), url, open, urgent };
  const label = kindTitles[kind] ? say(...kindTitles[kind]) : "";
  return { title: label ? `${instanceName()} · ${label}` : instanceName(), text: excerpt(localizedMessage(notification.body, locale)), url, open, urgent };
}

export function testMessage(locale: Locale): MessengerMessage {
  const say = translate(locale);
  return {
    title: instanceName(),
    text: say("Testnachricht – Benachrichtigungen aus Flowplan kommen hier an.", "Test message – notifications from Flowplan arrive here."),
    url: `${appUrl()}/#settings/notifications/messengers`,
    open: say("Einstellungen öffnen", "Open settings"),
  };
}

// Where and with which credentials a target sends; null when it cannot
// (the instance's bot is gone, the sealed secret does not open).
function route(t: TargetRow, bot: Bot | null): { config: MessengerConfig; secrets: MessengerSecrets } | null {
  const config = parseConfig(t.config);
  if (t.service === "telegram" && t.mode === "bot") {
    if (!bot) return null;
    return { config: { apiUrl: bot.apiUrl, chatId: config.chatId }, secrets: { token: bot.token } };
  }
  const secrets = openTargetSecrets(t);
  if (t.secret && !Object.keys(secrets).length) return null;
  return { config, secrets };
}
// The instance's own bot talks to an address the administrators chose;
// people's targets only to what checkServerUrl let through.
const allowPrivateFor = (t: Pick<TargetRow, "service" | "mode">) => (t.service === "telegram" && t.mode === "bot" ? true : messengerAllowPrivate());

async function deliverTo(t: TargetRow, bot: Bot | null, message: MessengerMessage, txn: string): Promise<SendOutcome> {
  const target = route(t, bot);
  if (!target) return { ok: false, reason: "auth" };
  return sendMessage(http(), t.service, target.config, target.secrets, message, txn, allowPrivateFor(t));
}

// A test from the settings, right away: the outcome is the answer.
export async function testMessenger(user: Identity, input: unknown, now = Date.now()) {
  requireBrowserUser(user);
  const targetId = z.string().max(60).parse((input as { id?: unknown })?.id);
  const target = one<TargetRow>("SELECT * FROM messenger_targets WHERE id=? AND user_id=?", targetId, user.id);
  if (!target) throw new HttpError(404, ct("Verbindung nicht gefunden.", "Connection not found."));
  const config = messengerConfig();
  if (!config.services[target.service])
    throw new HttpError(403, ct(`${messengerNames[target.service]} ist auf dieser Instanz ausgeschaltet.`, `${messengerNames[target.service]} is switched off on this instance.`));
  runtime.flowplanMessengerTests ??= new Map();
  const recent = (runtime.flowplanMessengerTests.get(user.id) || []).filter((at) => at > now - 60_000);
  if (recent.length >= TEST_PER_MINUTE) throw new HttpError(429, ct("Zu viele Testnachrichten – bitte warte eine Minute.", "Too many test messages – wait a minute."));
  runtime.flowplanMessengerTests.set(user.id, [...recent, now]);
  const outcome = await deliverTo(target, config.bot, testMessage(userLocale(user.id)), `test-${id()}`);
  if (outcome.ok) {
    run("UPDATE messenger_targets SET last_ok_at=?,last_error=NULL WHERE id=?", Date.now(), target.id);
    return { ok: true as const, overview: messengerOverview(user) };
  }
  const code = failureCode(outcome)!;
  run("UPDATE messenger_targets SET last_error=? WHERE id=?", code, target.id);
  return { ok: false as const, error: code, overview: messengerOverview(user) };
}

/* ---------- Queue ---------- */

const backoff = (attempts: number) => Math.min(3600_000, 30_000 * 2 ** attempts);
type Job = TargetRow & {
  delivery_id: number;
  attempts: number;
  notification_id: string | null;
  d_title: string | null;
  d_body: string | null;
  d_url: string | null;
  n_body: string | null;
  n_kind: string | null;
  n_page_id: string | null;
  n_row_id: string | null;
  n_thread_id: string | null;
  n_read_at: string | null;
  n_exists: number | null;
  disabled_user: number;
};

// Why a target was turned off, as the inbox notification says it.
function disableTarget(t: TargetRow, outcome: SendOutcome) {
  const detail = outcome.ok ? "" : outcome.reason === "private" ? "SSRF" : `HTTP ${outcome.status ?? "?"}`;
  if (!run("UPDATE messenger_targets SET enabled=0,disabled_reason=? WHERE id=? AND enabled=1", failureCode(outcome), t.id).changes) return;
  run(
    "INSERT INTO notifications(id,user_id,body,kind) VALUES(?,?,?,'security')",
    id(),
    t.user_id,
    `Chat-App ${messengerNames[t.service]} ausgeschaltet: wiederholt abgewiesen (${detail}). Bitte unter Einstellungen → Benachrichtigungen prüfen und wieder einschalten.`,
  );
  // What waits for it is dropped; the notifications stay in the inbox.
  run("DELETE FROM messenger_deliveries WHERE target_id=? AND delivered_at IS NULL", t.id);
}

function sentLastMinute(targetId: string, now: number) {
  return Number(
    one<{ n: number }>("SELECT COUNT(*) n FROM messenger_deliveries WHERE target_id=? AND delivered_at>?", targetId, now - 60_000)?.n || 0,
  );
}

async function handle(job: Job, bot: Bot | null, services: Record<MessengerService, boolean>, now: number) {
  const drop = () => run("DELETE FROM messenger_deliveries WHERE id=?", job.delivery_id);
  if (!job.enabled || job.disabled_user || !services[job.service]) return drop();
  // Per target at most RATE_PER_MINUTE a minute: the rest waits, no attempt lost.
  if (sentLastMinute(job.id, now) >= RATE_PER_MINUTE) {
    run("UPDATE messenger_deliveries SET available_at=?,attempts=MAX(0,attempts-1) WHERE id=?", now + 30_000, job.delivery_id);
    return;
  }
  const locale = userLocale(job.user_id);
  const { preview } = personalSettings(job.user_id);
  let message: MessengerMessage;
  if (job.notification_id) {
    // Read in the app meanwhile, removed, or no longer accessible: not sent.
    if (!job.n_exists || job.n_read_at) return drop();
    const page = job.n_page_id ? one<Page>("SELECT * FROM pages WHERE id=?", job.n_page_id) : undefined;
    if (job.n_page_id && (!page || page.deleted_at || !pageRole({ id: job.user_id } as Identity, page))) return drop();
    if (job.n_row_id && !one("SELECT 1 FROM rows WHERE id=? AND page_id=?", job.n_row_id, job.n_page_id)) return drop();
    message = notificationMessage(
      { body: job.n_body, kind: job.n_kind, page_id: job.n_page_id, row_id: job.n_row_id, thread_id: job.n_thread_id },
      locale,
      { preview, encrypted: !!page && isEncryptedPage(page) },
    );
  } else {
    const say = translate(locale);
    message = preview
      ? { title: job.d_title || instanceName(), text: excerpt(job.d_body || "", 500), url: job.d_url || appUrl(), open: say("In Flowplan öffnen", "Open in Flowplan"), urgent: true }
      : { title: instanceName(), text: say("Neue Betriebswarnung in Flowplan", "New operations alert in Flowplan"), url: job.d_url || appUrl(), open: say("In Flowplan öffnen", "Open in Flowplan"), urgent: true };
  }
  const outcome = await deliverTo(job, bot, message, `fp-${job.delivery_id}`);
  if (outcome.ok) {
    run("UPDATE messenger_deliveries SET delivered_at=?,last_error=NULL WHERE id=?", Date.now(), job.delivery_id);
    run("UPDATE messenger_targets SET failures=0,last_ok_at=?,last_error=NULL WHERE id=?", Date.now(), job.id);
    return;
  }
  const code = failureCode(outcome);
  run("UPDATE messenger_targets SET last_error=? WHERE id=?", code, job.id);
  switch (outcome.reason) {
    case "rate_limited":
      // Not a failed attempt: again once the service allows it.
      run(
        "UPDATE messenger_deliveries SET available_at=?,attempts=MAX(0,attempts-1),last_error=? WHERE id=?",
        Date.now() + (outcome.retryAfter ?? 60) * 1000,
        code,
        job.delivery_id,
      );
      return;
    case "auth":
    case "notfound":
    case "private": {
      const failures = job.failures + 1;
      run("UPDATE messenger_targets SET failures=? WHERE id=?", failures, job.id);
      if (failures >= DISABLE_AFTER) return disableTarget(job, outcome);
      break;
    }
    case "rejected":
      // The service will not take this message however often it comes.
      run("UPDATE messenger_deliveries SET attempts=?,last_error=? WHERE id=?", MAX_ATTEMPTS, code, job.delivery_id);
      return;
  }
  run("UPDATE messenger_deliveries SET available_at=?,last_error=? WHERE id=?", Date.now() + backoff(job.attempts), code, job.delivery_id);
}

export async function flushMessengerQueue(now = Date.now()) {
  run("DELETE FROM messenger_deliveries WHERE created_at<?", now - 7 * DAY);
  const jobs = all<Job>(
    `SELECT t.*,d.id delivery_id,d.attempts,d.notification_id,d.title d_title,d.body d_body,d.url d_url,
       n.body n_body,n.kind n_kind,n.page_id n_page_id,n.row_id n_row_id,n.thread_id n_thread_id,n.read_at n_read_at,
       CASE WHEN n.id IS NULL THEN 0 ELSE 1 END n_exists,u.disabled disabled_user
     FROM messenger_deliveries d JOIN messenger_targets t ON t.id=d.target_id JOIN users u ON u.id=t.user_id
     LEFT JOIN notifications n ON n.id=d.notification_id
     WHERE d.delivered_at IS NULL AND d.attempts<? AND d.available_at<=? ORDER BY d.id LIMIT 100`,
    MAX_ATTEMPTS,
    now,
  );
  if (!jobs.length) return;
  const config = messengerConfig();
  // Targets in parallel, each one's messages in order.
  const byTarget = new Map<string, Job[]>();
  for (const job of jobs) byTarget.set(job.id, [...(byTarget.get(job.id) || []), job]);
  await Promise.all(
    [...byTarget.values()].map(async (list) => {
      for (const job of list) {
        // Claimed first: another run must not send the same message.
        if (
          !run(
            "UPDATE messenger_deliveries SET available_at=?,attempts=attempts+1 WHERE id=? AND available_at<=? AND delivered_at IS NULL",
            now + 60_000,
            job.delivery_id,
            now,
          ).changes
        )
          continue;
        const fresh = one<{ enabled: number; failures: number }>("SELECT enabled,failures FROM messenger_targets WHERE id=?", job.id);
        if (!fresh) continue;
        await handle({ ...job, enabled: fresh.enabled, failures: fresh.failures }, config.bot, config.services, now);
      }
    }),
  );
}

/* ---------- Operations alerts for administrators ---------- */

// Health alerts (lib/admin-ops.ts) to the chat apps of administrators who
// want them. Security incidents are not sent here: they already reach the
// administrators as notifications of the kind "security", which go to their
// chat apps through the matrix like every other kind.
export function opsMessengerAdmins() {
  const admins = adminUserIds();
  if (!admins.length) return [];
  return admins.filter(
    (userId) =>
      personalSettings(userId).ops && !!one("SELECT 1 FROM messenger_targets WHERE user_id=? AND enabled=1", userId),
  );
}
export function queueOpsAlert(title: (say: (de: string, en: string) => string) => string, detail: string, now = Date.now()) {
  const services = messengerConfig().services;
  let queued = 0;
  for (const userId of opsMessengerAdmins()) {
    const say = translate(userLocale(userId));
    for (const t of all<{ id: string; service: MessengerService }>("SELECT id,service FROM messenger_targets WHERE user_id=? AND enabled=1", userId)) {
      if (!services[t.service]) continue;
      run(
        "INSERT INTO messenger_deliveries(target_id,title,body,url,available_at,created_at) VALUES(?,?,?,?,?,?)",
        t.id,
        `${instanceName()} · ${title(say)}`,
        detail,
        `${appUrl()}/#admin/monitoring`,
        now,
        now,
      );
      queued++;
    }
  }
  if (queued) void dispatchMessengers();
  return queued;
}

/* ---------- Telegram: the instance's bot ---------- */

const codeHash = (code: string) => createHash("sha256").update(`telegram-link:${code}`).digest("hex");

// A one-time code for the deep link https://t.me/<bot>?start=<code>:
// valid LINK_MINUTES, once; a new one replaces the person's earlier ones.
export async function createTelegramLink(user: Identity, now = Date.now()): Promise<TelegramLink> {
  requireBrowserUser(user);
  const config = messengerConfig();
  if (!config.services.telegram)
    throw new HttpError(403, ct("Telegram ist auf dieser Instanz ausgeschaltet.", "Telegram is switched off on this instance."));
  if (!config.bot) throw new HttpError(400, ct("Diese Instanz hat keinen Telegram-Bot eingerichtet.", "This instance has no Telegram bot set up."));
  const recent = Number(one<{ n: number }>("SELECT COUNT(*) n FROM telegram_links WHERE user_id=? AND expires>?", user.id, now - 45 * 60_000)?.n || 0);
  if (recent >= 10) throw new HttpError(429, ct("Zu viele Verbindungscodes – bitte später erneut.", "Too many connection codes – try again later."));
  const username = config.bot.username || (await refreshBotName(config.bot));
  if (!username) throw new HttpError(502, ct("Der Telegram-Bot antwortet nicht – bitte Administration prüfen.", "The Telegram bot does not answer – ask an administrator."));
  run("DELETE FROM telegram_links WHERE user_id=? AND used_at IS NULL", user.id);
  const code = randomBytes(18).toString("base64url");
  const expires = now + LINK_MINUTES * 60_000;
  run("INSERT INTO telegram_links(code_hash,user_id,expires) VALUES(?,?,?)", codeHash(code), user.id, expires);
  ensureTelegramPolling();
  return { url: `https://t.me/${username}?start=${code}`, code, expires, username };
}

export type LinkResult = { status: "linked"; userId: string } | { status: "invalid" | "expired" | "used" | "unavailable" };

// "/start <code>" from a private chat: binds that chat to the person the
// code belongs to. Unknown, used and expired codes bind nothing.
export function consumeTelegramCode(code: string, chatId: string, now = Date.now()): LinkResult {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return { status: "invalid" };
  const hash = codeHash(code);
  const row = one<{ user_id: string; expires: number; used_at: number | null }>("SELECT user_id,expires,used_at FROM telegram_links WHERE code_hash=?", hash);
  if (!row) return { status: "invalid" };
  if (row.used_at) return { status: "used" };
  if (row.expires < now) return { status: "expired" };
  const config = messengerConfig();
  const person = one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", row.user_id);
  if (!config.services.telegram || !config.bot || !person || person.disabled) return { status: "unavailable" };
  // Claimed once, even when two messages carry the same code.
  if (!run("UPDATE telegram_links SET used_at=?,chat_id=? WHERE code_hash=? AND used_at IS NULL AND expires>=?", now, chatId, hash, now).changes)
    return { status: "used" };
  const existing = one<{ id: string }>("SELECT id FROM messenger_targets WHERE user_id=? AND service='telegram'", row.user_id);
  saveTarget(row.user_id, existing?.id ?? id(), "telegram", "bot", { chatId }, null, "", !!existing);
  return { status: "linked", userId: row.user_id };
}

type TelegramUpdate = {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string; type?: string }; from?: { language_code?: string } };
};

// The answer in the chat: in the person's language once known, else in
// the language of their Telegram app.
function linkReply(result: LinkResult, languageCode: string | undefined) {
  const locale: Locale = result.status === "linked" ? userLocale(result.userId) : languageCode?.startsWith("de") ? "de" : languageCode?.startsWith("fr") ? "fr" : "en";
  const say = translate(locale);
  switch (result.status) {
    case "linked":
      return say(
        `Verbunden – Benachrichtigungen aus ${instanceName()} kommen jetzt hier an. Was ankommt, stellst du unter Einstellungen → Benachrichtigungen ein.`,
        `Connected – notifications from ${instanceName()} now arrive here. Choose what arrives under Settings → Notifications.`,
      );
    case "expired":
      return say("Dieser Code ist abgelaufen. Erzeuge in Flowplan einen neuen Link.", "This code has expired. Create a new link in Flowplan.");
    case "used":
      return say("Dieser Code wurde schon verwendet.", "This code has already been used.");
    case "unavailable":
      return say("Telegram ist auf dieser Instanz gerade nicht verfügbar.", "Telegram is not available on this instance right now.");
    default:
      return say(
        "Öffne den Link aus Flowplan (Einstellungen → Benachrichtigungen → Chat-Apps), um diesen Chat zu verbinden.",
        "Open the link from Flowplan (Settings → Notifications → Chat apps) to connect this chat.",
      );
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate, bot: Bot, now = Date.now()) {
  const message = update.message;
  const chat = message?.chat;
  if (!message?.text || chat?.id === undefined || chat.type !== "private") return null;
  const match = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(message.text.trim());
  if (!match) return null;
  const result: LinkResult = match[1] ? consumeTelegramCode(match[1], String(chat.id), now) : { status: "invalid" };
  try {
    await http()(
      {
        url: telegramMethodUrl(bot.apiUrl, bot.token, "sendMessage"),
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ chat_id: chat.id, text: linkReply(result, message.from?.language_code) }),
      },
      { allowPrivate: true },
    );
  } catch {}
  return result;
}

async function telegramCall(bot: Bot, method: string, body: unknown, timeout = 10_000) {
  const response = await http()(
    { url: telegramMethodUrl(bot.apiUrl, bot.token, method), method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { allowPrivate: true, timeout },
  );
  let data: { ok?: boolean; result?: unknown; description?: string; error_code?: number } = {};
  try {
    data = JSON.parse(response.body);
  } catch {}
  return { status: response.status, data };
}

// The bot's @name (getMe), remembered for the deep links.
async function refreshBotName(bot: Bot): Promise<string | null> {
  try {
    const { status, data } = await telegramCall(bot, "getMe", {});
    const username = status === 200 && data.ok ? (data.result as { username?: string })?.username : null;
    if (!username) return null;
    if (bot.source === "env") setState("telegramBot", JSON.stringify({ hash: tokenHash(bot.token), username }));
    else {
      const stored = readStored();
      if (stored.bot) writeStored({ ...stored, bot: { ...stored.bot, username } });
    }
    return username;
  } catch {
    return null;
  }
}

const pendingLinks = (now = Date.now()) => !!one("SELECT 1 FROM telegram_links WHERE used_at IS NULL AND expires>? LIMIT 1", now);

// One getUpdates round; `timeout` seconds of long polling.
export async function pollTelegram(timeout = 20, now = Date.now()) {
  const config = messengerConfig();
  const bot = config.bot;
  if (!bot || !config.services.telegram) return [];
  const offset = Number(state("telegramOffset") || 0);
  let answer;
  try {
    answer = await telegramCall(bot, "getUpdates", { offset: offset || undefined, timeout, allowed_updates: ["message"] }, (timeout + 10) * 1000);
  } catch (error) {
    setState("telegramPoll", JSON.stringify({ at: now, error: "unreachable" }));
    throw error;
  }
  if (answer.status !== 200 || !answer.data.ok) {
    // 409: a webhook is set for the bot, or another program polls it.
    const error = answer.status === 409 ? "conflict" : answer.status === 401 || answer.status === 404 ? `auth:${answer.status}` : `server:${answer.status}`;
    setState("telegramPoll", JSON.stringify({ at: now, error }));
    throw new Error(error);
  }
  setState("telegramPoll", JSON.stringify({ at: now, error: null }));
  const updates = (Array.isArray(answer.data.result) ? answer.data.result : []) as TelegramUpdate[];
  const results: (LinkResult | null)[] = [];
  for (const update of updates) {
    if (typeof update.update_id === "number") setState("telegramOffset", String(update.update_id + 1));
    results.push(await handleTelegramUpdate(update, bot, Date.now()));
  }
  return results;
}

// Polls while a link code waits; stops by itself once none is left. Tests
// (with their own transport) call pollTelegram themselves.
export function ensureTelegramPolling() {
  if (runtime.flowplanTelegramPoll || runtime.flowplanMessengerHttp) return;
  runtime.flowplanTelegramPoll = (async () => {
    while (pendingLinks()) {
      try {
        await pollTelegram(20);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })().finally(() => {
    runtime.flowplanTelegramPoll = undefined;
  });
}

/* ---------- Administration ---------- */

const hostEntry = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$|^\[?[0-9a-f:.]+\]?$/);
const adminInput = z.object({
  services: z.object(Object.fromEntries(messengerServices.map((s) => [s, z.boolean().optional()])) as Record<MessengerService, z.ZodOptional<z.ZodBoolean>>).optional(),
  allowedHosts: z.array(hostEntry).max(50).optional(),
});

// For the administration: a bot from the environment learns its @name
// (getMe) the first time the section is opened.
export async function messengerAdminStatusFresh(): Promise<MessengerAdminStatus> {
  const bot = messengerConfig().bot;
  if (bot && !bot.username) await refreshBotName(bot);
  return messengerAdminStatus();
}

export function messengerAdminStatus(): MessengerAdminStatus {
  const config = messengerConfig();
  const stored = readStored();
  let poll: { at: number; error: string | null } | null = null;
  try {
    poll = JSON.parse(state("telegramPoll") || "null");
  } catch {}
  const counts = all<{ service: MessengerService; enabled: number; n: number }>(
    "SELECT service,enabled,COUNT(*) n FROM messenger_targets GROUP BY service,enabled",
  );
  const targets = Object.fromEntries(
    messengerServices.map((s) => [
      s,
      {
        active: counts.find((c) => c.service === s && c.enabled)?.n ?? 0,
        disabled: counts.find((c) => c.service === s && !c.enabled)?.n ?? 0,
      },
    ]),
  ) as MessengerAdminStatus["targets"];
  const count = (sql: string, ...args: number[]) => Number(one<{ n: number }>(sql, ...args)?.n || 0);
  const now = Date.now();
  return {
    services: config.services,
    servicesFromEnv: config.servicesFromEnv,
    allowedHosts: config.allowedHosts,
    allowPrivate: messengerAllowPrivate(),
    bot: {
      configured: !!config.bot,
      source: config.bot?.source ?? (stored.bot ? "stored" : null),
      tokenHint: config.bot ? `…${config.bot.token.slice(-4)}` : "",
      apiUrl: config.bot?.apiUrl ?? stored.bot?.apiUrl ?? TELEGRAM_API,
      apiUrlDefault: (config.bot?.apiUrl ?? TELEGRAM_API) === TELEGRAM_API,
      username: config.bot?.username ?? null,
      lastError: config.botError ?? poll?.error ?? null,
      lastPollAt: poll?.at ?? null,
    },
    targets,
    deliveries: {
      delivered: count("SELECT COUNT(*) n FROM messenger_deliveries WHERE delivered_at>?", now - DAY),
      failed: count("SELECT COUNT(*) n FROM messenger_deliveries WHERE delivered_at IS NULL AND attempts>=? AND created_at>?", MAX_ATTEMPTS, now - DAY),
      pending: count("SELECT COUNT(*) n FROM messenger_deliveries WHERE delivered_at IS NULL AND attempts<?", MAX_ATTEMPTS),
      lastError:
        one<{ last_error: string }>("SELECT last_error FROM messenger_deliveries WHERE last_error IS NOT NULL AND created_at>? ORDER BY id DESC LIMIT 1", now - DAY)
          ?.last_error ?? null,
    },
  };
}

export function saveMessengerAdmin(actor: Identity, input: unknown) {
  const b = adminInput.parse(input);
  const stored = readStored();
  const next: StoredConfig = { ...stored };
  if (b.services) next.services = { ...messengerConfig().services, ...b.services };
  if (b.allowedHosts) next.allowedHosts = [...new Set(b.allowedHosts.map((h) => h.replace(/^\[|\]$/g, "")))];
  writeStored(next);
  const detail = `messengers ${messengerServices.filter((s) => (next.services ?? messengerConfig().services)[s]).join(",") || "none"}${next.allowedHosts?.length ? ` hosts:${next.allowedHosts.length}` : ""}`;
  audit(actor.id, "admin.messengers", "instance", detail);
  securityEvent("admin.settings", { actorId: actor.id, detail });
  return messengerAdminStatus();
}

const botInput = z.object({
  token: z.string().trim().max(200).optional(),
  apiUrl: z.string().trim().max(500).optional(),
});

// Sets or changes the instance's bot: the token is checked with getMe
// before it is stored (sealed). An empty token keeps the stored one.
export async function saveMessengerBot(actor: Identity, input: unknown) {
  const b = botInput.parse(input);
  const stored = readStored();
  const current = messengerConfig().bot;
  const token = b.token || (current?.source === "stored" ? current.token : "");
  if (!token) throw new HttpError(400, ct("Bot-Token fehlt.", "Bot token is missing."));
  if (!TELEGRAM_TOKEN.test(token)) throw new HttpError(400, ct("Das sieht nicht wie ein Bot-Token aus (123456:ABC…).", "That does not look like a bot token (123456:ABC…)."));
  let apiUrl = TELEGRAM_API;
  if (b.apiUrl && b.apiUrl.replace(/\/+$/, "") !== TELEGRAM_API) {
    let url: URL;
    try {
      url = new URL(b.apiUrl);
    } catch {
      throw new HttpError(400, ct("Ungültige API-Adresse.", "Invalid API address."));
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new HttpError(400, ct("Die API-Adresse braucht http(s):// und keine Zugangsdaten oder Parameter.", "The API address needs http(s):// and no credentials or parameters."));
    apiUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  const bot: Bot = { token, apiUrl, username: null, source: "stored" };
  let me;
  try {
    me = await telegramCall(bot, "getMe", {});
  } catch {
    throw new HttpError(502, ct(`Die Telegram-API unter ${hostOf(apiUrl)} ist nicht erreichbar.`, `The Telegram API at ${hostOf(apiUrl)} is not reachable.`));
  }
  if (me.status === 401 || me.status === 404) throw new HttpError(400, ct("Telegram lehnt den Bot-Token ab.", "Telegram refuses the bot token."));
  const username = me.status === 200 && me.data.ok ? (me.data.result as { username?: string })?.username : undefined;
  if (!username) throw new HttpError(502, ct(`Die Telegram-API antwortet unerwartet (HTTP ${me.status}).`, `The Telegram API answers unexpectedly (HTTP ${me.status}).`));
  writeStored({ ...stored, bot: { token: sealSecret(token, "messenger-bot"), apiUrl, username } });
  setState("telegramOffset", null);
  setState("telegramPoll", null);
  audit(actor.id, "admin.messenger_bot", "instance", `@${username} ${hostOf(apiUrl)}`);
  securityEvent("admin.messenger_bot", { actorId: actor.id, detail: `@${username} ${hostOf(apiUrl)}` });
  return messengerAdminStatus();
}

// Removes the stored bot (the environment's token, if any, applies again).
export function removeMessengerBot(actor: Identity) {
  const stored = readStored();
  if (!stored.bot) throw new HttpError(400, ct("Es ist kein Bot gespeichert.", "No bot is stored."));
  writeStored({ ...stored, bot: null });
  setState("telegramOffset", null);
  setState("telegramPoll", null);
  audit(actor.id, "admin.messenger_bot", "instance", "removed");
  securityEvent("admin.messenger_bot", { actorId: actor.id, detail: "removed" });
  return messengerAdminStatus();
}

/* ---------- Worker ---------- */

export function dispatchMessengers() {
  runtime.flowplanMessengerRun ??= flushMessengerQueue()
    .catch((error) => console.error("Chat-App-Versand fehlgeschlagen", error))
    .finally(() => {
      runtime.flowplanMessengerRun = undefined;
    });
  return runtime.flowplanMessengerRun;
}

export function startMessengerWorker() {
  if (runtime.flowplanMessengerTimer) return;
  runtime.flowplanMessengerTimer = setInterval(() => {
    void dispatchMessengers();
    // A code may have been made by another process (several replicas).
    if (pendingLinks()) ensureTelegramPolling();
  }, 15_000);
  runtime.flowplanMessengerTimer.unref?.();
  void dispatchMessengers();
}
