"use client";
// Choosing the model (#538): when a person's groups and roles allow more
// than one model of the instance's provider (AiStatus.provider.choice,
// lib/ai/model-policy.ts), the AI panel, the writing assistant, the AI
// actions and Einstellungen → KI let them pick one. The choice is stored on
// the server (command ai.settings { instanceModel }) and applies at once to
// every feature, on every device; workflows keep the default. The server
// checks it against the allowed set – the browser only offers.
import { useEffect, useId, useState } from "react";
import { api } from "./ui";
import { useT } from "./i18n";
import { Select } from "./select";
import { modelDisplayName, modelFamilyName } from "@/lib/ai/ask-suggestions";
import type { AiStatus } from "@/lib/ai/features";
import type { ModelTier } from "@/lib/ai/quota-shared";

type T = (de: string, en: string) => string;
export type AiModelChoiceInfo = NonNullable<NonNullable<AiStatus["provider"]>["choice"]>;

// i18n-table: 1 – [German, English] pairs
const TIER_HINTS: Record<ModelTier, readonly [string, string]> = {
  fast: ["schnell & günstig", "fast & low-cost"],
  balanced: ["ausgewogen", "balanced"],
  strong: ["am stärksten", "most capable"],
};
export const tierHint = (tier: ModelTier, t: T) => t(TIER_HINTS[tier][0], TIER_HINTS[tier][1]);
const nameOf = (model: string) => modelDisplayName(model) || model;

// A model rule with the choice (#538): "Bis Opus – frei wählbar" – that
// model or one of the instance's smaller ones, the person's choice.
export const upToLabel = (model: string, t: T) => {
  const name = modelFamilyName(model);
  return t(`Bis ${name} – frei wählbar`, `Up to ${name} – your choice`);
};

// Tell the workspace to load the AI status again (components/workspace-app.tsx).
export const announceAiChange = () => window.dispatchEvent(new Event("flowplan:ai-changed"));

// Stores the choice ('' = the default) and announces it.
async function storeChoice(model: string, choice: AiModelChoiceInfo) {
  await api("/api/command", { action: "ai.settings", instanceModel: model === choice.default ? "" : model });
  announceAiChange();
}

// The picked model shows at once and stays until the AI status has it.
function useChoice(current: string, choice: AiModelChoiceInfo, onChanged?: () => unknown) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setPicked(null), [current]);
  const pick = async (model: string) => {
    if (model === (picked ?? current)) return;
    setPicked(model);
    setBusy(true);
    setError("");
    try {
      await storeChoice(model, choice);
      await onChanged?.();
    } catch (e) {
      setPicked(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { value: picked ?? current, busy, error, pick };
}

// The quota note: a smaller model stretches a quota that counts cost.
function QuotaNote({ choice }: { choice: AiModelChoiceInfo }) {
  const t = useT();
  if (!choice.costQuota) return null;
  return <p className="ai-model-choice-note">{t("Dein Kontingent zählt Kosten – mit kleineren Modellen reicht es länger.", "Your quota counts cost – smaller models make it last longer.")}</p>;
}

// A radio group: in the AI panel's model details.
export function AiModelRadios({ current, choice, onChanged }: { current: string; choice: AiModelChoiceInfo; onChanged?: () => unknown }) {
  const t = useT();
  const name = useId();
  const { value, busy, error, pick } = useChoice(current, choice, onChanged);
  return (
    <fieldset className="ai-model-choice" aria-busy={busy || undefined}>
      <legend>{t("Modell wählen", "Choose the model")}</legend>
      {choice.models.map((m) => (
        <label key={m.model} className={`ai-model-option${value === m.model ? " active" : ""}`}>
          <input type="radio" name={name} value={m.model} checked={value === m.model} onChange={() => void pick(m.model)} />
          <span className="ai-model-option-text">
            <span className="ai-model-option-name">
              {nameOf(m.model)}
              {m.model === choice.default && <small>{t(" · Standard", " · default")}</small>}
            </span>
            <small className="ai-model-option-hint">{tierHint(m.tier, t)}</small>
          </span>
        </label>
      ))}
      <QuotaNote choice={choice} />
      {error && (
        <p className="ai-model-choice-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

// A compact select: beside the provider line of the writing assistant and
// the AI actions, and as "Standardmodell" in Einstellungen → KI.
export function AiModelSelect({ current, choice, id, className = "", label, onChanged }: { current: string; choice: AiModelChoiceInfo; id?: string; className?: string; label?: string; onChanged?: () => unknown }) {
  const t = useT();
  const { value, busy, error, pick } = useChoice(current, choice, onChanged);
  return (
    <>
      <Select id={id} className={`ai-model-select ${className}`} aria-label={id ? undefined : (label ?? t("Modell", "Model"))} value={value} aria-busy={busy || undefined} onChange={(e) => void pick(e.target.value)}>
        {choice.models.map((m) => (
          <option key={m.model} value={m.model}>
            {`${nameOf(m.model)} · ${tierHint(m.tier, t)}${m.model === choice.default ? t(" (Standard)", " (default)") : ""}`}
          </option>
        ))}
      </Select>
      {error && (
        <span className="ai-model-choice-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
