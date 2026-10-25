// The push relay's state in words (lib/push-status.ts): shared by the tile
// of the landing page, the health tile of the monitoring and
// Administration → Push-Benachrichtigungen.
import type { Probe, PushSummary } from "@/lib/push-status";
import type { Tone } from "../../settings-ui";
import { ms, num } from "./monitoring-format";

type T = (de: string, en: string) => string;

export const relayHost = (url: string | null) => {
  if (!url) return "–";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// Why the relay is off (the same words as the test notification's).
export function relayReason(t: T, reason: PushSummary["reason"]) {
  if (reason === "off") return t("PUSH_RELAY=off ist gesetzt.", "PUSH_RELAY=off is set.");
  if (reason === "instance-url") return t("APP_URL ist keine https-Adresse.", "APP_URL is not an https address.");
  if (reason === "relay-url") return t("PUSH_RELAY_URL ist keine gültige https-Adresse.", "PUSH_RELAY_URL is not a valid https address.");
  return "";
}

// Why a check failed, in a few words.
export function probeErrorText(t: T, p: Pick<Probe, "error" | "httpStatus">) {
  const status = p.httpStatus ?? 0;
  switch (p.error) {
    case "timeout":
      return t("Zeitüberschreitung (5 s)", "Timed out (5 s)");
    case "refused":
      return t("Verbindung abgelehnt", "Connection refused");
    case "dns":
      return t("Name nicht auflösbar (DNS)", "Name not found (DNS)");
    case "tls":
      return t("TLS-Fehler (Zertifikat)", "TLS error (certificate)");
    case "redirect":
      return t(`Weiterleitung (HTTP ${status}) – wird nicht gefolgt`, `Redirect (HTTP ${status}) – not followed`);
    case "http":
      return status === 503 ? t("HTTP 503 – meldet sich als nicht verfügbar", "HTTP 503 – reports itself unavailable") : `HTTP ${status}`;
    case "too-large":
      return t("Antwort zu groß", "Answer too large");
    case "response":
      return t("Unerwartete Antwort", "Unexpected answer");
    case "insecure":
      return t("Keine https-Adresse", "Not an https address");
    case "mismatch":
      return t("Der Signaturschlüssel dieser Instanz fehlt im Dokument", "This instance's signing key is missing from the document");
    default:
      return t("Netzwerkfehler", "Network error");
  }
}

// "Erreichbar (85 ms)" or why not.
export function reachabilityText(t: T, p: Pick<Probe, "ok" | "ms" | "error" | "httpStatus">) {
  return p.ok ? t(`Erreichbar (${ms(p.ms)})`, `Reachable (${ms(p.ms)})`) : `${t("Nicht erreichbar", "Not reachable")}: ${probeErrorText(t, p)}`;
}

// The tile: one line, a coloured badge (green, amber, red) and the
// deliveries of 24 hours.
export function pushTile(s: PushSummary, t: T): { line: string; tone: Tone; badge: string } {
  const host = relayHost(s.url);
  const kind = s.official ? t("offizielles Relay", "official relay") : t("eigenes Relay", "custom relay");
  if (!s.enabled)
    return {
      line: `${t("Relay aus", "Relay off")} – ${relayReason(t, s.reason)}${s.mobile ? "" : " · MOBILE_PUSH=off"}`,
      tone: s.tone,
      badge: s.reason === "off" ? t("Relay aus", "Relay off") : s.reason === "relay-url" ? t("PUSH_RELAY_URL ungültig", "PUSH_RELAY_URL invalid") : t("APP_URL nicht https", "APP_URL not https"),
    };
  // The delivered count is the tile's figure; failures go into the line.
  const line = [host, kind, s.failed24h ? t(`${num(s.failed24h)} fehlgeschlagen (24 Std.)`, `${num(s.failed24h)} failed (24 h)`) : null]
    .filter(Boolean)
    .join(" · ");
  if (!s.health) return { line, tone: "info", badge: t("Wird geprüft", "Checking") };
  if (!s.health.ok) return { line, tone: "error", badge: reachabilityText(t, s.health) };
  if (s.self && !s.self.ok) return { line, tone: "warn", badge: t("/.well-known von hier nicht erreichbar", "/.well-known not reachable from here") };
  if (s.tone === "warn") return { line, tone: "warn", badge: t("Letzte Zustellung fehlgeschlagen", "Last delivery failed") };
  return { line, tone: "ok", badge: reachabilityText(t, s.health) };
}
