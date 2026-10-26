"use client";
// The AI status of the open workspace (bootstrap → ai) for the writing
// assistant and the summaries, wherever they appear: the editor, the text
// menu, the page menu, databases and records. Entry points are hidden when
// the feature is not usable for this person and disabled with a hint on
// pages the AI may not read.
//
// On the Flowplan apps for iPhone, iPad and Mac some features also run on
// the device (Apple's model, lib/ai/device.ts): entry points that pass
// { device: true } appear there even without the server's AI.
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Cloud, DeviceMobile, HardDrives } from "@phosphor-icons/react";
import { AI_PROVIDER_NAMES, AI_PROVIDER_NAMES_EN, type AiFeature, type AiStatus } from "@/lib/ai/features";
import { aiPageReadable, aiUsable } from "@/lib/ai/client";
import { aiRoute, checkDeviceAi, deviceAiState, subscribeDeviceAi, type AiRoute, type DeviceAiState } from "@/lib/ai/device";
import { useLocale, useT } from "./i18n";

type AiContextValue = { status: AiStatus | null; workspaceId: string | null };
const AiContext = createContext<AiContextValue>({ status: null, workspaceId: null });

export function AiProvider({ status, workspaceId, children }: AiContextValue & { children: ReactNode }) {
  return <AiContext.Provider value={{ status, workspaceId }}>{children}</AiContext.Provider>;
}
export function useAi() {
  return useContext(AiContext);
}

// "hidden": no entry point; "blocked": shown but disabled (the hint says
// why); "ok": usable.
export type AiAvailability = "hidden" | "blocked" | "ok";
export function useAiAvailability(feature: AiFeature, pageId: string | null | undefined, options?: { device?: boolean; encrypted?: boolean }): AiAvailability {
  const { status } = useAi();
  const route = useAiRoute(feature, pageId, { ...options, status, enabled: !!options?.device });
  if (options?.device) return route.availability;
  if (!aiUsable(status, feature)) return "hidden";
  return pageId && !aiPageReadable(status, pageId) ? "blocked" : "ok";
}

// Whether this device can run Apple's model (asked once the server allows
// it here, again when the app comes back to the foreground).
const SERVER_STATE: DeviceAiState = { bridge: false, checked: false, availability: null };
const serverState = () => SERVER_STATE;
export function useDeviceAi(wanted: boolean): DeviceAiState {
  const state = useSyncExternalStore(subscribeDeviceAi, deviceAiState, serverState);
  useEffect(() => {
    if (!wanted) return;
    void checkDeviceAi();
    const again = () => {
      if (document.visibilityState === "visible") void checkDeviceAi(true);
    };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [wanted]);
  return state;
}
// Where an action runs (lib/ai/device.ts aiRoute). With enabled: false the
// device is never asked (the server alone decides).
export function useAiRoute(
  feature: AiFeature,
  pageId: string | null | undefined,
  options: { encrypted?: boolean; status?: AiStatus | null; enabled?: boolean } = {},
): AiRoute {
  const context = useAi();
  const locale = useLocale();
  const status = options.status === undefined ? context.status : options.status;
  const wanted = options.enabled !== false && !!status?.device?.features[feature];
  const device = useDeviceAi(wanted);
  return aiRoute({ status, feature, pageId, encrypted: options.encrypted, device: wanted ? device.availability : null, locale });
}
export const useAiBlockedHint = () => {
  const t = useT();
  return t("KI hat keinen Zugriff auf diese Seite", "The AI has no access to this page");
};

// "Ollama · llama3.1 · lokal" / "OpenAI-kompatibel · gpt-4.1 · Daten gehen
// an api.openai.com" – where the text goes, shown wherever AI runs.
export function aiProviderFooter(provider: AiStatus["provider"], t: (de: string, en: string) => string) {
  if (!provider) return t("Kein KI-Anbieter", "No AI provider");
  const name = t(AI_PROVIDER_NAMES[provider.kind], AI_PROVIDER_NAMES_EN[provider.kind]);
  const parts = [name, provider.model].filter(Boolean);
  return `${parts.join(" · ")} · ${provider.local ? t("lokal", "local") : t(`Daten gehen an ${provider.host || name}`, `Data goes to ${provider.host || name}`)}`;
}
// Where a result came from: Apple's model on this device.
export function DeviceAiChip() {
  const t = useT();
  return (
    <span className="ai-device-chip" title={t("Mit Apple Intelligence auf diesem Gerät erstellt – der Text hat das Gerät nicht verlassen.", "Made with Apple Intelligence on this device – the text did not leave the device.")}>
      <DeviceMobile size={12} weight="bold" aria-hidden />
      {t("Auf diesem Gerät", "On this device")}
    </span>
  );
}

export function AiProviderFooter({ device = false }: { device?: boolean }) {
  const t = useT();
  const { status } = useAi();
  if (device)
    return (
      <p className="ai-footer device" title={t("Der Text verlässt das Gerät nicht.", "The text does not leave the device.")}>
        <DeviceMobile size={13} aria-hidden />
        <span>{t("Apple Intelligence · nur auf diesem Gerät", "Apple Intelligence · only on this device")}</span>
      </p>
    );
  const provider = status?.provider || null;
  const Icon = provider?.local ? HardDrives : Cloud;
  return (
    <p className={`ai-footer${provider && !provider.local ? " external" : ""}`}>
      <Icon size={13} aria-hidden />
      <span>{aiProviderFooter(provider, t)}</span>
    </p>
  );
}
