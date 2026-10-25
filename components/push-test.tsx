"use client";
// "Send test notification" (Settings → Notifications → Push): sends a test
// to every push target of the signed-in person (lib/push-test.ts) and shows
// per browser and app installation the channel and what happened – with
// what to do when it did not arrive. Administrators also see where the
// relay is and what this instance calls itself.
import { useState } from "react";
import { CheckCircle, CircleNotch, WarningCircle, Info } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";
import type { PushTestReport, PushTestTarget } from "@/lib/push-test";

type Translate = ReturnType<typeof useT>;

// The state of this browser, which the server cannot know: not subscribed
// here, or notifications blocked in the browser.
export type ThisBrowser = "subscribed" | "off" | "denied" | null;

function channelLabel(t: Translate, target: PushTestTarget) {
  if (target.channel === "relay") return t("Relay · Ende-zu-Ende-verschlüsselt", "Relay · end-to-end encrypted");
  if (target.channel === "expo") return "Expo";
  if (target.channel === "web") return "Web Push";
  return t("Nicht für Push registriert", "Not registered for push");
}

function relayReason(t: Translate, reason: PushTestReport["relay"]["reason"]) {
  if (reason === "off") return t("PUSH_RELAY=off ist gesetzt.", "PUSH_RELAY=off is set.");
  if (reason === "instance-url") return t("APP_URL ist keine https-Adresse.", "APP_URL is not an https address.");
  if (reason === "relay-url") return t("PUSH_RELAY_URL ist keine gültige https-Adresse.", "PUSH_RELAY_URL is not a valid https address.");
  return "";
}

function deliveredText(t: Translate, target: PushTestTarget) {
  if (target.channel === "relay")
    return target.platform === "android" ? t("An Google (FCM) zugestellt", "Delivered to Google (FCM)") : target.platform === "ios" ? t("An Apple (APNs) zugestellt", "Delivered to Apple (APNs)") : t("An Apple bzw. Google zugestellt", "Delivered to Apple/Google");
  if (target.channel === "expo") return t("An Expo übergeben", "Handed to Expo");
  if (target.service === "apple") return t("An den Push-Dienst von Apple zugestellt", "Delivered to Apple's push service");
  if (target.service === "google") return t("An den Push-Dienst von Google zugestellt", "Delivered to Google's push service");
  if (target.service === "mozilla") return t("An den Push-Dienst von Mozilla zugestellt", "Delivered to Mozilla's push service");
  if (target.service === "microsoft") return t("An den Push-Dienst von Microsoft zugestellt", "Delivered to Microsoft's push service");
  return t("An den Push-Dienst zugestellt", "Delivered to the push service");
}

// What happened and what to do, in one sentence or two.
export function statusText(t: Translate, target: PushTestTarget, report: PushTestReport) {
  const detail = target.detail || "";
  switch (target.status) {
    case "delivered":
      return deliveredText(t, target);
    case "pending":
      return t("Keine Antwort innerhalb von 10 Sekunden – die Zustellung läuft eventuell noch.", "No answer within 10 seconds – delivery may still be under way.");
    case "push-disabled":
      return t(
        "Benachrichtigungen sind für dieses Gerät ausgeschaltet. Erlaube sie in der App (Einstellungen → Benachrichtigungen) oder in den Systemeinstellungen.",
        "Notifications are turned off for this device. Allow them in the app (Settings → Notifications) or in the system settings.",
      );
    case "app-push-off":
      return t("Push für die Apps ist auf dieser Instanz ausgeschaltet (MOBILE_PUSH=off).", "Push to the apps is turned off on this instance (MOBILE_PUSH=off).");
    case "relay-off":
      return `${t("Das Push-Relay ist auf dieser Instanz nicht eingerichtet:", "The push relay is not set up on this instance:")} ${relayReason(t, report.relay.reason)}`.trim();
    case "relay-unreachable":
      return t(
        "Das Push-Relay ist nicht erreichbar (Zeitüberschreitung oder Verbindung abgelehnt). Die Instanz braucht ausgehenden HTTPS-Zugang zum Relay.",
        "The push relay cannot be reached (timeout or connection refused). The instance needs outgoing HTTPS access to the relay.",
      );
    case "relay-signature": {
      const origin = report.relay.instance || (typeof window === "undefined" ? "" : window.location.origin);
      return t(
        `Das Relay konnte diese Instanz nicht verifizieren – ist ${origin}/.well-known/flowplan-push erreichbar?`,
        `The relay could not verify this instance – is ${origin}/.well-known/flowplan-push reachable?`,
      );
    }
    case "relay-blocked":
      return t("Das Relay hat diese Instanz gesperrt (HTTP 403). Wende dich an den Betreiber des Relays.", "The relay has blocked this instance (HTTP 403). Contact the relay's operator.");
    case "relay-rejected":
      return t(`Das Relay hat die Anfrage abgelehnt (${detail}).`, `The relay rejected the request (${detail}).`);
    case "relay-unexpected":
      return t("Das Relay hat unerwartet geantwortet. Später erneut versuchen.", "The relay answered unexpectedly. Try again later.");
    case "relay-upstream":
      return t("Apple bzw. Google hat die Benachrichtigung nicht angenommen (Fehler über das Relay). Später erneut versuchen.", "Apple/Google did not accept the notification (error from the relay). Try again later.");
    case "relay-rate-limited":
      return t(`Das Relay drosselt gerade – in ${detail || "60"} Sekunden erneut versuchen.`, `The relay is throttling – try again in ${detail || "60"} seconds.`);
    case "relay-registration":
      return t("Die Registrierung dieses Geräts ist abgelaufen. Öffne die App einmal, damit sie sich neu anmeldet.", "This device's registration has expired. Open the app once so it registers again.");
    case "expo-gone":
      return t("Das Gerät ist bei Expo nicht mehr registriert (App gelöscht?). Öffne die App einmal, damit sie sich neu anmeldet.", "The device is no longer registered with Expo (app removed?). Open the app once so it registers again.");
    case "expo-error":
      return detail ? t(`Expo hat die Benachrichtigung abgelehnt (${detail}).`, `Expo rejected the notification (${detail}).`) : t("Expo hat die Benachrichtigung abgelehnt.", "Expo rejected the notification.");
    case "web-gone":
      return t("Das Push-Abonnement dieses Browsers ist abgelaufen und wurde entfernt. Aktiviere Push dort erneut.", "This browser's push subscription has expired and was removed. Enable push there again.");
    case "web-error":
      return t(`Der Push-Dienst hat abgelehnt (${detail}).`, `The push service refused (${detail}).`);
    case "web-unreachable":
      return t("Der Push-Dienst ist nicht erreichbar.", "The push service cannot be reached.");
  }
}

function noteText(t: Translate, target: PushTestTarget) {
  const notes: string[] = [];
  if (target.note === "relay-off") notes.push(t("Über Expo gesendet, weil das Push-Relay hier nicht eingerichtet ist.", "Sent through Expo because the push relay is not set up here."));
  if (target.note === "relay-registration")
    notes.push(t("Das Relay hat die Registrierung abgelehnt; über Expo gesendet. Öffne die App einmal, damit sie sich neu beim Relay anmeldet.", "The relay refused the registration; sent through Expo. Open the app once so it registers with the relay again."));
  if (target.focus)
    notes.push(t("Auf diesem Gerät ist ein Fokus aktiv – das System kann die Mitteilung still zustellen oder zurückhalten.", "A Focus is on for this device – the system may deliver the notification quietly or hold it back."));
  return notes;
}

function targetName(t: Translate, target: PushTestTarget) {
  const name = target.name || (target.kind === "app" ? (target.platform === "android" ? t("Android-App", "Android app") : t("Flowplan-App", "Flowplan app")) : t("Browser", "Browser"));
  return target.current ? `${name} (${t("dieser Browser", "this browser")})` : name;
}

export default function PushTest({ thisBrowser = null }: { thisBrowser?: ThisBrowser }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<PushTestReport | null>(null);
  const [error, setError] = useState("");
  async function send() {
    setBusy(true);
    setError("");
    try {
      setReport(await api<PushTestReport>("/api/push", { action: "test" }));
    } catch (e) {
      setReport(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const delivered = report?.targets.filter((target) => target.status === "delivered").length ?? 0;
  const currentListed = !!report?.targets.some((target) => target.current);
  return (
    <div className="push-test">
      <button type="button" className="button" onClick={() => void send()} disabled={busy} aria-busy={busy} aria-describedby="push-test-hint">
        {busy && <CircleNotch size={14} aria-hidden className="spin" />}
        {busy ? t("Wird gesendet …", "Sending …") : t("Testbenachrichtigung senden", "Send test notification")}
      </button>
      <p id="push-test-hint" className="push-test-hint">
        {t(
          "An alle deine Browser und Apps mit Push – unabhängig von den Benachrichtigungsarten und Ruhezeiten, nicht aber von den Systemeinstellungen des Geräts.",
          "To all your browsers and apps with push – regardless of notification kinds and quiet hours, but not of the device's system settings.",
        )}
      </p>
      <div aria-live="polite" className="push-test-live">
        {error && (
          <p className="push-test-error" role="alert">
            {error}
          </p>
        )}
        {report && (
          <>
            <p className="push-test-summary">
              {report.targets.length
                ? t(`${delivered} von ${report.targets.length} zugestellt`, `${delivered} of ${report.targets.length} delivered`)
                : t(
                    "Keine Geräte für Push registriert. Öffne die Flowplan-App und erlaube Benachrichtigungen oder aktiviere Push oben in diesem Browser.",
                    "No devices registered for push. Open the Flowplan app and allow notifications, or enable push above in this browser.",
                  )}
            </p>
            {report.targets.length > 0 && (
              <ul className="push-test-results">
                {report.targets.map((target) => {
                  const ok = target.status === "delivered";
                  const notes = noteText(t, target);
                  return (
                    <li key={target.key} className={ok ? "ok" : "problem"} data-status={target.status}>
                      {ok ? <CheckCircle size={18} weight="fill" aria-hidden /> : <WarningCircle size={18} weight="fill" aria-hidden />}
                      <div>
                        <strong>{targetName(t, target)}</strong>
                        <span className="push-test-channel">{channelLabel(t, target)}</span>
                        <span className="push-test-status">
                          <span className="sr-only">{ok ? t("Erfolgreich:", "Success:") : t("Problem:", "Problem:")} </span>
                          {statusText(t, target, report)}
                          {ok && " ✓"}
                        </span>
                        {notes.map((note) => (
                          <span key={note} className="push-test-note">
                            <Info size={14} aria-hidden /> {note}
                          </span>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {!currentListed && (thisBrowser === "off" || thisBrowser === "denied") && (
              <p className="push-test-note">
                <Info size={14} aria-hidden />{" "}
                {thisBrowser === "denied"
                  ? t("In diesem Browser sind Benachrichtigungen blockiert. Erlaube sie in den Website-Einstellungen des Browsers.", "Notifications are blocked in this browser. Allow them in the browser's site settings.")
                  : t("Dieser Browser ist nicht für Push angemeldet – aktiviere Push oben, um ihn mitzutesten.", "This browser is not signed up for push – enable push above to include it in the test.")}
              </p>
            )}
            {report.diagnostics && (
              <p className="push-test-diagnostics">
                {t("Diagnose (Administration):", "Diagnostics (administrators):")} {t("Relay", "Relay")} <code>{report.diagnostics.relayUrl || "–"}</code>
                {report.relay.enabled ? "" : ` (${t("aus", "off")}${report.relay.reason ? `: ${relayReason(t, report.relay.reason)}` : ""})`} · /.well-known/flowplan-push{" "}
                {report.diagnostics.wellKnown ? t("aktiv", "enabled") : t("nicht aktiv", "not enabled")} · {t("Instanz (APP_URL)", "Instance (APP_URL)")} <code>{report.diagnostics.instance || "–"}</code>
                {report.diagnostics.mobilePush ? "" : " · MOBILE_PUSH=off"}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
