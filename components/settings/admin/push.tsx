"use client";
// Administration → Push-Benachrichtigungen (lib/push-status.ts,
// /api/admin/push): which push relay the apps' notifications go through,
// whether it answers right now, whether the relay can fetch this instance's
// key, the signing keys, the Expo fallback, Web Push and the deliveries of
// 24 hours. "Erreichbarkeit prüfen" checks again at once (otherwise the
// checks are a minute old at most).
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowsClockwise, PaperPlaneTilt } from "@phosphor-icons/react";
import type { PushStatus } from "@/lib/push-status";
import { useT } from "../../i18n";
import { api, Modal } from "../../ui";
import { ResponsiveTable, SettingGroup, SettingRow, StatusBadge, type Tone } from "../../settings-ui";
import { Sparkline } from "../../sparkline";
import { useAdmin } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, useDocs, type StatusItem } from "./parts";
import { ago, dateTime, num } from "./monitoring-format";
import { probeErrorText, reachabilityText, relayHost, relayReason } from "./push-format";

type T = (de: string, en: string) => string;
type Channel = "relay" | "expo" | "web";
const RESULTS = ["ok", "gone", "forbidden", "invalid", "rate_limited", "error"] as const;

const channelName = (c: Channel, t: T) => (c === "relay" ? t("Relay (Apps)", "Relay (apps)") : c === "expo" ? t("Expo (ältere Apps)", "Expo (older apps)") : t("Web Push (Browser)", "Web Push (browsers)"));
const resultName = (r: (typeof RESULTS)[number], t: T) =>
  ({
    ok: t("zugestellt", "delivered"),
    gone: t("abgemeldet", "gone"),
    forbidden: t("abgewiesen", "forbidden"),
    invalid: t("ungültig", "invalid"),
    rate_limited: t("gedrosselt", "rate limited"),
    error: t("Fehler", "error"),
  })[r];

export default function PushSection() {
  const t = useT();
  const docs = useDocs();
  const { onError } = useAdmin();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [rotating, setRotating] = useState<null | "ask" | "busy">(null);
  const [immediate, setImmediate] = useState(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const load = useCallback(async (check = false) => {
    if (check) setChecking(true);
    try {
      setStatus(await api<PushStatus>("/api/admin/push", check ? { action: "check" } : undefined));
    } catch (e) {
      errorRef.current((e as Error).message);
    } finally {
      if (check) setChecking(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!status) return <AdminLoading />;

  const r = status.relay;
  const guide = docs("configuration", "push-relay-und-ende-zu-ende-verschluesselung", "push-relay-and-end-to-end-encryption");
  const ownRelay = docs("configuration", "eigenes-push-relay-betreiben", "running-your-own-push-relay");
  const testLink = "#settings/notifications/push-test";
  const items: StatusItem[] = [];
  if (!r.enabled) items.push({ tone: r.reason === "off" ? "off" : r.reason === "relay-url" ? "error" : "warn", label: r.reason === "off" ? t("Relay aus", "Relay off") : t("Relay nicht eingerichtet", "Relay not set up") });
  else if (!r.health) items.push({ tone: "info", label: t("Wird geprüft", "Checking") });
  else items.push({ tone: r.health.ok ? "ok" : "error", label: r.health.ok ? reachabilityText(t, r.health) : t("Relay nicht erreichbar", "Relay not reachable") });
  if (r.enabled && r.self && !r.self.ok) items.push({ tone: "warn", label: t("/.well-known von hier nicht erreichbar", "/.well-known not reachable from here") });
  if (status.deliveries.lastError && status.tone === "warn" && (!r.self || r.self.ok)) items.push({ tone: "warn", label: t("Letzte Zustellung fehlgeschlagen", "Last delivery failed") });
  if (!status.mobile.enabled) items.push({ tone: "off", label: "MOBILE_PUSH=off" });

  const sentence = !r.enabled
    ? `${relayReason(t, r.reason)} ${
        r.reason === "off"
          ? t("Die Apps bekommen Mitteilungen nur noch über Expo, wenn sie ein Expo-Token haben (ältere App-Versionen).", "The apps only get notifications through Expo when they have an Expo token (older app versions).")
          : t("Bis das behoben ist, bekommen die Apps aus App Store und Google Play keine Mitteilungen über das Relay.", "Until that is fixed, the apps from the App Store and Google Play get no notifications through the relay.")
      }`
    : r.health && !r.health.ok
      ? t(
          `Die Instanz erreicht ${relayHost(r.url)} nicht – Mitteilungen an die Apps warten und werden erneut versucht. Sie braucht ausgehenden HTTPS-Zugang zum Relay.`,
          `The instance cannot reach ${relayHost(r.url)} – notifications to the apps wait and are retried. It needs outgoing HTTPS access to the relay.`,
        )
      : t(
          `Mitteilungen an die Apps gehen Ende-zu-Ende-verschlüsselt über ${relayHost(r.url)}.`,
          `Notifications to the apps go end-to-end encrypted through ${relayHost(r.url)}.`,
        );

  const checkButton = (
    <button type="button" className="button compact" onClick={() => void load(true)} disabled={checking || !r.enabled} aria-busy={checking}>
      <ArrowClockwise size={15} aria-hidden className={checking ? "spin" : undefined} />
      {checking ? t("Wird geprüft …", "Checking …") : t("Erreichbarkeit prüfen", "Check now")}
    </button>
  );
  const pendingKey = r.keys.find((k) => !k.signing && k.activeFrom > status.at);
  const signingKey = r.keys.find((k) => k.signing);
  const d = status.deliveries;
  const rows = (["relay", "expo", "web"] as Channel[]).map((c) => ({ channel: c, ...d.totals[c] }));
  const failed = (c: (typeof rows)[number]) => c.forbidden + c.invalid + c.rate_limited + c.error;

  return (
    <>
      <AdminStatus
        items={items}
        action={
          !r.enabled && r.reason !== "off" ? (
            <FixLink href={guide}>{t("So richtest du es ein", "How to set it up")}</FixLink>
          ) : (
            <FixLink href={testLink}>{t("Testbenachrichtigung senden", "Send a test notification")}</FixLink>
          )
        }
      >
        {sentence}
      </AdminStatus>

      <SettingGroup
        id="relay"
        title={t("Push-Relay", "Push relay")}
        description={t(
          "Über das Relay gehen Mitteilungen an die Apps für iPhone, iPad und Android – Ende-zu-Ende-verschlüsselt, signiert mit dem Schlüssel dieser Instanz.",
          "Notifications to the apps for iPhone, iPad and Android go through the relay – end-to-end encrypted, signed with this instance's key.",
        )}
        actions={checkButton}
      >
        <SettingRow
          label={t("Relay", "Relay")}
          description={r.custom ? t("Aus PUSH_RELAY_URL.", "From PUSH_RELAY_URL.") : t("Standard – PUSH_RELAY_URL ist nicht gesetzt.", "Default – PUSH_RELAY_URL is not set.")}
        >
          <span className="push-status-value">
            <code className="admin-break">{r.url || t("ungültige Adresse", "invalid address")}</code>
            <StatusBadge tone={r.official ? "ok" : "info"}>{r.official ? t("Offizielles Relay", "Official relay") : t("Eigenes Relay", "Custom relay")}</StatusBadge>
          </span>
        </SettingRow>
        <SettingRow
          label={t("Zustand", "State")}
          description={r.enabled ? t("PUSH_RELAY ist nicht ausgeschaltet; APP_URL und PUSH_RELAY_URL sind gültig.", "PUSH_RELAY is not switched off; APP_URL and PUSH_RELAY_URL are valid.") : relayReason(t, r.reason)}
        >
          <StatusBadge tone={r.enabled ? "ok" : r.reason === "off" ? "off" : r.reason === "relay-url" ? "error" : "warn"}>{r.enabled ? t("An", "On") : t("Aus", "Off")}</StatusBadge>
        </SettingRow>
        {r.enabled && (
          <SettingRow
            label={t("Erreichbarkeit", "Reachability")}
            description={
              r.health
                ? [
                    `GET /healthz · ${t("geprüft", "checked")} ${ago(r.health.at, t, status.at)}`,
                    r.health.version ? t(`Version ${r.health.version}`, `version ${r.health.version}`) : null,
                    !r.health.ok && r.health.error === "redirect" ? t("Das Relay muss ohne Weiterleitung antworten.", "The relay must answer without a redirect.") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : t("Noch nicht geprüft.", "Not checked yet.")
            }
          >
            <span className="push-status-value" data-testid="push-relay-health">
              {r.health ? <StatusBadge tone={r.health.ok ? "ok" : "error"}>{reachabilityText(t, r.health)}</StatusBadge> : <StatusBadge tone="info">{t("Wird geprüft", "Checking")}</StatusBadge>}
            </span>
          </SettingRow>
        )}
        <SettingRow label={t("Instanz (APP_URL)", "Instance (APP_URL)")} description={t("So kennt das Relay diese Instanz; die Apps melden sich für genau diese Adresse an.", "This is how the relay knows this instance; the apps register for exactly this address.")}>
          <code className="admin-break">{r.instance || "–"}</code>
        </SettingRow>
        <SettingRow
          label="/.well-known/flowplan-push"
          description={
            !r.wellKnown
              ? t("Wird nur bei eingeschaltetem Relay veröffentlicht.", "Only published while the relay is on.")
              : !r.self
                ? t("Der öffentliche Schlüssel dieser Instanz für das Relay.", "This instance's public key for the relay.")
                : r.self.ok
                  ? t(`Von dieser Instanz aus unter ${r.wellKnownUrl} abgerufen (${ago(r.self.at, t, status.at)}).`, `Fetched from this instance at ${r.wellKnownUrl} (${ago(r.self.at, t, status.at)}).`)
                  : t(
                      `Von dieser Instanz aus unter ${r.wellKnownUrl} nicht abrufbar: ${probeErrorText(t, r.self)}. Hinter NAT oder einem Proxy, der die eigene Adresse von innen nicht auflöst, ist das normal – entscheidend ist, dass das Relay die Adresse von außen erreicht. Prüfe das mit einer Testbenachrichtigung.`,
                      `Not reachable from this instance at ${r.wellKnownUrl}: ${probeErrorText(t, r.self)}. Behind NAT or a proxy that does not resolve its own address from inside this is normal – what counts is that the relay reaches it from outside. Check with a test notification.`,
                    )
          }
        >
          <span className="push-status-value" data-testid="push-well-known">
            <StatusBadge tone={!r.wellKnown ? "off" : !r.self ? "ok" : r.self.ok ? "ok" : "warn"}>
              {!r.wellKnown ? t("Nicht veröffentlicht", "Not published") : r.self && !r.self.ok ? t("Veröffentlicht · von hier nicht erreichbar", "Published · not reachable from here") : t("Veröffentlicht", "Published")}
            </StatusBadge>
          </span>
        </SettingRow>
        <SettingRow label={t("Anleitung", "Guide")} description={t("Einrichtung, eigenes Relay und Datenschutz.", "Setup, running your own relay and privacy.")}>
          <span className="push-status-links">
            <FixLink href={guide}>{t("Push-Relay", "Push relay")}</FixLink>
            {!r.official && <FixLink href={ownRelay}>{t("Eigenes Relay", "Own relay")}</FixLink>}
          </span>
        </SettingRow>
      </SettingGroup>

      {r.enabled && (
        <SettingGroup
          id="keys"
          title={t("Signaturschlüssel", "Signing key")}
          description={t(
            "Mit diesem Ed25519-Schlüssel signiert die Instanz jede Anfrage an das Relay. Er wechselt nicht von selbst; ein neuer Schlüssel wird sofort veröffentlicht und signiert nach gut einer Stunde.",
            "The instance signs every request to the relay with this Ed25519 key. It does not change on its own; a new key is published at once and signs after a little more than an hour.",
          )}
          actions={
            <button type="button" className="button compact" onClick={() => setRotating("ask")}>
              <ArrowsClockwise size={15} aria-hidden />
              {t("Schlüssel wechseln …", "Rotate key …")}
            </button>
          }
        >
          <ResponsiveTable
            label={t("Signaturschlüssel", "Signing keys")}
            rows={r.keys}
            rowKey={(k) => k.id}
            columns={[
              { key: "id", header: t("Schlüssel-ID", "Key id"), primary: true, render: (k) => <code className="admin-break">{k.id}</code> },
              {
                key: "state",
                header: t("Status", "Status"),
                render: (k) => (
                  <StatusBadge tone={k.signing ? "ok" : k.activeFrom > status.at ? "info" : "off"}>
                    {k.signing ? t("Signiert", "Signing") : k.activeFrom > status.at ? t("Wartet", "Waiting") : t("Auslaufend", "Retiring")}
                  </StatusBadge>
                ),
              },
              { key: "from", header: t("Signiert ab", "Signs from"), render: (k) => dateTime(k.activeFrom) },
              { key: "until", header: t("Gelistet bis", "Listed until"), render: (k) => (k.retireAt ? dateTime(k.retireAt) : t("unbegrenzt", "no end")) },
            ]}
          />
          <p className="admin-note push-status-note" role="note">
            {pendingKey
              ? t(`Wechsel läuft: ${pendingKey.id} signiert ab ${dateTime(pendingKey.activeFrom)}.`, `Rotation under way: ${pendingKey.id} signs from ${dateTime(pendingKey.activeFrom)}.`)
              : signingKey
                ? t(`Signiert seit ${dateTime(signingKey.activeFrom)}. Kein Wechsel geplant.`, `Signing since ${dateTime(signingKey.activeFrom)}. No rotation planned.`)
                : t("Noch kein Schlüssel – er entsteht beim ersten Gebrauch.", "No key yet – it is created on first use.")}
          </p>
        </SettingGroup>
      )}

      <SettingGroup
        id="deliveries"
        title={t("Zustellungen der letzten 24 Stunden", "Deliveries of the last 24 hours")}
        description={t("Antworten der Push-Dienste je Kanal – Zahlen, keine Inhalte.", "Answers of the push services per channel – counts, no content.")}
      >
        {!d.collecting && (
          <p className="admin-note push-status-note">
            {t("Die Statistik ist ausgeschaltet (Überwachung → Statistik); gezählt wird nichts, nur der letzte Erfolg und Fehler.", "Statistics are off (Monitoring → Statistics); nothing is counted, only the last success and failure.")}
          </p>
        )}
        <div className="mon-table">
          <ResponsiveTable
            label={t("Zustellungen je Kanal", "Deliveries per channel")}
            rows={rows}
            rowKey={(c) => c.channel}
            columns={[
              { key: "channel", header: t("Kanal", "Channel"), primary: true, render: (c) => channelName(c.channel, t) },
              ...RESULTS.map((res) => ({
                key: res,
                header: resultName(res, t),
                align: "end" as const,
                render: (c: (typeof rows)[number]) => (d.collecting ? num(c[res]) : "–"),
              })),
            ]}
          />
        </div>
        {d.collecting && (
          <SettingRow label={t("Verlauf", "Trend")} description={t("Zugestellt je Stunde.", "Delivered per hour.")}>
            <span className="push-status-spark">
              <Sparkline values={d.hourly.map((h) => h.ok)} label={t("Zugestellte Push-Benachrichtigungen je Stunde, letzte 24 Stunden", "Delivered push notifications per hour, last 24 hours")} />
            </span>
          </SettingRow>
        )}
        <SettingRow label={t("Letzte Zustellung über das Relay", "Last delivery through the relay")} description={d.lastOk.relay ? dateTime(d.lastOk.relay) : undefined}>
          <span data-testid="push-last-ok">{d.lastOk.relay ? ago(d.lastOk.relay, t, status.at) : t("noch keine", "none yet")}</span>
        </SettingRow>
        <SettingRow
          label={t("Letzter Fehler", "Last error")}
          description={d.lastError ? `${channelName(d.lastError.channel, t)} · ${dateTime(d.lastError.at)}` : t("Keiner seit dem Start der Zählung.", "None since counting began.")}
        >
          {d.lastError ? (
            <StatusBadge tone={(d.lastError.at > (d.lastOk[d.lastError.channel] ?? 0) ? "error" : "warn") as Tone}>
              {[resultName(d.lastError.result, t), d.lastError.code].filter(Boolean).join(" · ")}
            </StatusBadge>
          ) : (
            <StatusBadge tone="ok">{t("Keiner", "None")}</StatusBadge>
          )}
        </SettingRow>
        <SettingRow label={t("Warteschlange", "Queue")} description={t("Wartende Benachrichtigungen und nach 5 Versuchen aufgegebene.", "Waiting notifications and those given up after 5 attempts.")}>
          <span>
            {t(`${num(status.queue.pending)} wartend · ${num(status.queue.givenUp)} aufgegeben`, `${num(status.queue.pending)} waiting · ${num(status.queue.givenUp)} given up`)}
          </span>
        </SettingRow>
        <SettingRow
          label={t("Registrierte Geräte", "Registered devices")}
          description={t(
            `${num(status.devices.apps)} App-Installationen: ${num(status.devices.relay)} über das Relay (${num(status.devices.relayOnly)} nur Relay), ${num(status.devices.expo)} mit Expo-Token. ${num(status.devices.web)} Browser mit Web Push.`,
            `${num(status.devices.apps)} app installations: ${num(status.devices.relay)} through the relay (${num(status.devices.relayOnly)} relay only), ${num(status.devices.expo)} with an Expo token. ${num(status.devices.web)} browsers with Web Push.`,
          )}
        >
          <FixLink href={testLink}>
            <PaperPlaneTilt size={14} aria-hidden /> {t("Testbenachrichtigung", "Test notification")}
          </FixLink>
        </SettingRow>
      </SettingGroup>

      <SettingGroup id="channels" title={t("Expo und Web Push", "Expo and Web Push")} description={t("Die anderen Wege: ältere App-Versionen über Expo, Browser über Web Push.", "The other ways: older app versions through Expo, browsers through Web Push.")}>
        <SettingRow label={t("Push an die Apps", "Push to the apps")} description="MOBILE_PUSH">
          <StatusBadge tone={status.mobile.enabled ? "ok" : "off"}>{status.mobile.enabled ? t("An", "On") : t("Aus", "Off")}</StatusBadge>
        </SettingRow>
        <SettingRow
          label={t("Text der Mitteilung", "Notification text")}
          description={
            status.mobile.content === "on"
              ? t("MOBILE_PUSH_CONTENT=on: auch über Expo und in Live-Aktivitäten – lesbar für Expo, Apple und Google.", "MOBILE_PUSH_CONTENT=on: also through Expo and in Live Activities – readable for Expo, Apple and Google.")
              : status.mobile.content === "off"
                ? t("MOBILE_PUSH_CONTENT=off: nie, nur „Neues im Posteingang“.", "MOBILE_PUSH_CONTENT=off: never, only “new in the inbox”.")
                : t("MOBILE_PUSH_CONTENT nicht gesetzt: nur über das Relay, wo er Ende-zu-Ende-verschlüsselt ist.", "MOBILE_PUSH_CONTENT not set: only through the relay, where it is end-to-end encrypted.")
          }
        >
          <StatusBadge tone="info">{status.mobile.content === "on" ? t("Überall", "Everywhere") : status.mobile.content === "off" ? t("Nie", "Never") : t("Nur verschlüsselt", "Encrypted only")}</StatusBadge>
        </SettingRow>
        <SettingRow
          label={t("Web Push (VAPID)", "Web Push (VAPID)")}
          description={
            status.web.vapid === "env"
              ? t("Schlüssel aus WEB_PUSH_PUBLIC_KEY und WEB_PUSH_PRIVATE_KEY.", "Keys from WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY.")
              : status.web.vapid === "partial"
                ? t("Nur eine der beiden Variablen WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY ist gesetzt – verwendet wird die erzeugte Datei.", "Only one of WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY is set – the generated file is used.")
                : status.web.vapid === "file"
                  ? t("Von Flowplan erzeugt (web-push-keys.json im Datenverzeichnis).", "Generated by Flowplan (web-push-keys.json in the data directory).")
                  : t("Wird beim ersten Abonnement erzeugt.", "Created with the first subscription.")
          }
        >
          <StatusBadge tone={status.web.vapid === "partial" ? "warn" : status.web.vapid === "pending" ? "info" : "ok"}>
            {status.web.vapid === "pending" ? t("Noch nicht erzeugt", "Not created yet") : status.web.vapid === "partial" ? t("Unvollständig", "Incomplete") : t("Eingerichtet", "Set up")}
          </StatusBadge>
        </SettingRow>
        <SettingRow label={t("Kontakt für die Push-Dienste", "Contact for the push services")} description="WEB_PUSH_SUBJECT">
          <StatusBadge tone={status.web.subject ? "ok" : "info"}>{status.web.subject ? t("Gesetzt", "Set") : t("APP_URL wird verwendet", "APP_URL is used")}</StatusBadge>
        </SettingRow>
      </SettingGroup>

      <Modal open={!!rotating} onClose={() => rotating !== "busy" && setRotating(null)} title={t("Signaturschlüssel wechseln?", "Rotate the signing key?")}>
        <div className="push-rotate">
          <p>
            {t(
              "Der neue Schlüssel wird sofort unter /.well-known/flowplan-push veröffentlicht und signiert nach gut einer Stunde – so kennt ihn das Relay rechtzeitig. Der bisherige bleibt 7 Tage gelistet.",
              "The new key is published at /.well-known/flowplan-push at once and signs after a little more than an hour – so the relay knows it in time. The current one stays listed for 7 days.",
            )}
          </p>
          <label className="push-rotate-option">
            <input type="checkbox" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} />
            <span>
              {t(
                "Sofort wechseln (bei einem womöglich bekannt gewordenen Schlüssel): der neue signiert sofort, alle alten verschwinden. Bis das Relay das Dokument neu lädt, können Zustellungen kurz fehlschlagen.",
                "Rotate immediately (for a key that may have leaked): the new one signs at once, all old ones go. Until the relay reloads the document, deliveries may fail briefly.",
              )}
            </span>
          </label>
          <div className="modal-actions">
            <button type="button" className="button" disabled={rotating === "busy"} onClick={() => setRotating(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button
              type="button"
              className={`button ${immediate ? "danger-solid" : "primary"}`}
              disabled={rotating === "busy"}
              onClick={async () => {
                setRotating("busy");
                try {
                  await api("/api/admin/operations", { action: "pushRelay.rotate", immediate });
                  setRotating(null);
                  setImmediate(false);
                  await load();
                } catch (e) {
                  errorRef.current((e as Error).message);
                  setRotating("ask");
                }
              }}
            >
              {rotating === "busy" ? t("Wird gewechselt …", "Rotating …") : immediate ? t("Sofort wechseln", "Rotate now") : t("Schlüssel wechseln", "Rotate key")}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
