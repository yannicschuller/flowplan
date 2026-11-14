// Offering offline use per device (#295): offline use is off on every new
// device, and people only notice once they are offline and nothing is
// there. The introduction asks on the device it runs on
// (components/onboarding.tsx, step "Auch ohne Verbindung arbeiten?"); every
// other browser or device the person signs in on later asks once with a
// small dismissible card (components/offline-offer.tsx). The answer is kept
// on the device (localStorage, like the offline switch itself, which lives
// in the device's storage – components/offline.ts): "Offline nutzen" and
// "Nicht mehr fragen" end it, "Später" asks again after a week.
//
// Not offered where offline use is not possible (no service worker or
// plain http), in the iPhone, iPad and Android app (it asks natively,
// lib/app-offline-offer.ts), to guests and the demo, and when the copy is on
// already. Shared and published pages never load the workspace app, so
// they never ask. Client-safe: plain functions.

export const OFFLINE_OFFER_KEY = "flowplan-offline-offer";
// "Später": asked again after this long.
export const LATER_MS = 7 * 86_400_000;

export type OfflineOfferAnswer = "enabled" | "never" | `later:${number}`;

export function parseOfferAnswer(value: string | null | undefined): { kind: "enabled" | "never" } | { kind: "later"; at: number } | null {
  if (value === "enabled" || value === "never") return { kind: value };
  const later = /^later:(\d{1,16})$/.exec(value || "");
  return later ? { kind: "later", at: Number(later[1]) } : null;
}

export type OfferFacts = {
  // Offline use works in this browser (components/offline.ts offlineSupported).
  supported: boolean;
  // The phone and tablet app (window.FlowplanApp): it offers offline itself.
  nativeApp: boolean;
  guest: boolean;
  demo: boolean;
  // The copy is on for this person on this device.
  enabled: boolean;
  // What was answered on this device.
  stored: string | null;
  now: number;
};

// Whether this device may be asked at all (the introduction's step uses
// this without the stored answer: there the person goes through it anyway).
export function offlineOfferPossible(f: Pick<OfferFacts, "supported" | "nativeApp" | "guest" | "demo" | "enabled">) {
  return f.supported && !f.nativeApp && !f.guest && !f.demo && !f.enabled;
}

// Whether the card asks on this device now.
export function shouldOfferOffline(f: OfferFacts) {
  if (!offlineOfferPossible(f)) return false;
  const answer = parseOfferAnswer(f.stored);
  if (!answer) return true;
  if (answer.kind === "later") return f.now - answer.at >= LATER_MS;
  return false;
}

export function readOfferAnswer(): string | null {
  try {
    return localStorage.getItem(OFFLINE_OFFER_KEY);
  } catch {
    return null;
  }
}
export function saveOfferAnswer(answer: "enabled" | "never" | "later", now = Date.now()) {
  try {
    localStorage.setItem(OFFLINE_OFFER_KEY, answer === "later" ? `later:${now}` : answer);
  } catch {}
}
