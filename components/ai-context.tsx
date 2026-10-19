"use client";
// The AI status of the open workspace (bootstrap → ai) for the writing
// assistant and the summaries, wherever they appear: the editor, the text
// menu, the page menu, databases and records. Entry points are hidden when
// the feature is not usable for this person and disabled with a hint on
// pages the AI may not read.
import { createContext, useContext, type ReactNode } from "react";
import { Cloud, HardDrives } from "@phosphor-icons/react";
import { AI_PROVIDER_NAMES, AI_PROVIDER_NAMES_EN, type AiFeature, type AiStatus } from "@/lib/ai/features";
import { aiPageReadable, aiUsable } from "@/lib/ai/client";
import { useT } from "./i18n";

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
export function useAiAvailability(feature: AiFeature, pageId: string | null | undefined): AiAvailability {
  const { status } = useAi();
  if (!aiUsable(status, feature)) return "hidden";
  return pageId && !aiPageReadable(status, pageId) ? "blocked" : "ok";
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
export function AiProviderFooter() {
  const t = useT();
  const { status } = useAi();
  const provider = status?.provider || null;
  const Icon = provider?.local ? HardDrives : Cloud;
  return (
    <p className={`ai-footer${provider && !provider.local ? " external" : ""}`}>
      <Icon size={13} aria-hidden />
      <span>{aiProviderFooter(provider, t)}</span>
    </p>
  );
}
