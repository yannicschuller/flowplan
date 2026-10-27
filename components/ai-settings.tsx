"use client";
// AI settings: Administration → KI (instance provider, who may use it,
// features), Settings → KI (own switches, own provider, what the AI may
// read), the per-person switch in Administration → Benutzer and "Für KI
// gesperrt" for pages and spaces, and Apple's on-device model in the apps
// (lib/ai/device.ts: optional, the administration's and each person's
// switch). API keys are only ever sent, never shown:
// the server answers with "stored · ends in …abcd" at most (lib/ai).
import { useEffect, useMemo, useState } from "react";
import { useLocale, useT } from "./i18n";
import { api } from "./ui";
import { Select } from "./select";
import { EmptyState, SaveBar, SaveState, SettingGroup, SettingRow, Switch, SwitchRow, useSaveState } from "./settings-ui";
import { AdminStatus, FixLink, type StatusItem } from "./settings/admin/parts";
import { serverMessage } from "@/lib/i18n-errors";
import {
  AI_DEFAULTS,
  AI_FEATURES,
  AI_PROVIDER_KINDS,
  AI_PROVIDER_NAMES,
  AI_PROVIDER_NAMES_EN,
  aiProviderLabel,
  type AiFeature,
  type AiProviderKind,
  type AiStatus,
} from "@/lib/ai/features";
import { aiReasonText } from "@/lib/ai/client";
import { DEVICE_REASON_TEXT, deviceReason } from "@/lib/ai/device";
import type { DeviceAiMode } from "@/lib/ai/features";
import { useDeviceAi } from "./ai-context";
import type { Bootstrap } from "@/lib/types";

type Provider = { kind: AiProviderKind; baseUrl: string; model: string; embeddingModel: string };
type KeyInfo = { stored: boolean; hint: string; fromEnv?: boolean; unreadable?: boolean };
type InstanceAi = {
  enabled: boolean;
  provider: Provider | null;
  access: "everyone" | "selected";
  guests: boolean;
  userProviders: boolean;
  features: Partial<Record<AiFeature, boolean>>;
  semanticSearch?: boolean;
  // Apple's on-device model in the apps (on unless switched off).
  device?: boolean;
};
type AdminView = {
  settings: InstanceAi;
  key: KeyInfo;
  env: { provider: { kind: AiProviderKind; baseUrl: string } | null; key: boolean };
  secretsKey: "encryption-key" | "secrets-key" | "file";
  allowedUsers: string[];
  // Semantic search (lib/ai/semantic.ts): what is stored.
  semantic?: { active: boolean; model: string; chunks: number; bytes: number; sources: number; pending: number };
};
type TestResult = { models: string[]; reply: string; ms: number; modelListed: boolean; listError: string };
// What the save sends for the key: a new one, null to remove, nothing to keep.
type KeyChange = { apiKey?: string | null };

const blankProvider = (kind: AiProviderKind = "ollama"): Provider => ({
  kind,
  baseUrl: AI_DEFAULTS[kind].baseUrl,
  model: AI_DEFAULTS[kind].model,
  embeddingModel: AI_DEFAULTS[kind].embeddingModel,
});
const sameEndpoint = (a: Provider | null, b: Provider | null) =>
  !!a && !!b && a.kind === b.kind && a.baseUrl.trim().replace(/\/+$/, "").toLowerCase() === b.baseUrl.trim().replace(/\/+$/, "").toLowerCase();

// Kind, address, models and key of one provider.
function ProviderFields({
  value,
  saved,
  keyInfo,
  keyChange,
  onChange,
  onKeyChange,
  own,
  models,
  idPrefix,
}: {
  value: Provider;
  saved: Provider | null;
  keyInfo: KeyInfo;
  keyChange: KeyChange;
  onChange: (next: Provider) => void;
  onKeyChange: (next: KeyChange) => void;
  // A person's own provider: public https addresses only.
  own: boolean;
  models: string[];
  idPrefix: string;
}) {
  const t = useT();
  const [replacing, setReplacing] = useState(false);
  const moved = keyInfo.stored && !!saved && !sameEndpoint(value, saved);
  const kindName = (kind: AiProviderKind) => t(AI_PROVIDER_NAMES[kind], AI_PROVIDER_NAMES_EN[kind]);
  const typing = typeof keyChange.apiKey === "string";
  return (
    <>
      <SettingRow id={`${idPrefix}-kind`} label={t("Anbieter", "Provider")} description={t("Ollama läuft auf deinem Server; die anderen sind Dienste im Internet oder kompatible Server (LM Studio, vLLM, LocalAI, OpenRouter, Mistral …).", "Ollama runs on your server; the others are internet services or compatible servers (LM Studio, vLLM, LocalAI, OpenRouter, Mistral …).")}>
        <Select
          id={`${idPrefix}-kind`}
          value={value.kind}
          onChange={(e) => {
            const kind = e.target.value as AiProviderKind;
            onChange(blankProvider(kind));
          }}
        >
          {AI_PROVIDER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindName(kind)}
            </option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        id={`${idPrefix}-url`}
        label={t("Adresse", "Address")}
        description={
          own
            ? t("Nur öffentliche https-Adressen. Bei OpenAI-kompatiblen Servern mit /v1 am Ende.", "Public https addresses only. For OpenAI-compatible servers ending in /v1.")
            : t("Darf im eigenen Netz liegen, z. B. http://ollama:11434. Bei OpenAI-kompatiblen Servern mit /v1 am Ende. Weiterleitungen werden nicht verfolgt.", "May be in your own network, e.g. http://ollama:11434. For OpenAI-compatible servers ending in /v1. Redirects are not followed.")
        }
      >
        <input id={`${idPrefix}-url`} type="url" maxLength={500} value={value.baseUrl} placeholder={AI_DEFAULTS[value.kind].baseUrl} onChange={(e) => onChange({ ...value, baseUrl: e.target.value })} />
      </SettingRow>
      <SettingRow id={`${idPrefix}-model`} label={t("Modell", "Model")} description={t("Jede Modell-ID des Anbieters, z. B. ", "Any model id of the provider, e.g. ") + AI_DEFAULTS[value.kind].model}>
        <input id={`${idPrefix}-model`} list={`${idPrefix}-models`} maxLength={200} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} />
        <datalist id={`${idPrefix}-models`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </SettingRow>
      {value.kind !== "anthropic" && (
        <SettingRow id={`${idPrefix}-embed`} label={t("Modell für Embeddings (optional)", "Embedding model (optional)")} description={t("Für die Suche nach Bedeutung, z. B. ", "For searching by meaning, e.g. ") + AI_DEFAULTS[value.kind].embeddingModel}>
          <input id={`${idPrefix}-embed`} list={`${idPrefix}-models`} maxLength={200} value={value.embeddingModel} onChange={(e) => onChange({ ...value, embeddingModel: e.target.value })} />
        </SettingRow>
      )}
      <SettingRow
        id={`${idPrefix}-key`}
        label={t("API-Schlüssel", "API key")}
        description={
          AI_DEFAULTS[value.kind].keyRequired
            ? t("Wird verschlüsselt gespeichert und nie wieder angezeigt.", "Stored encrypted and never shown again.")
            : t("Nur falls der Server einen verlangt. Wird verschlüsselt gespeichert und nie wieder angezeigt.", "Only if the server requires one. Stored encrypted and never shown again.")
        }
      >
        {keyInfo.fromEnv && !typing && !keyInfo.stored ? (
          <span className="setting-value">{t("aus Umgebungsvariable", "from environment variable")}</span>
        ) : keyInfo.stored && !moved && !replacing && keyChange.apiKey !== null ? (
          <>
            <span className="setting-value">
              {keyInfo.unreadable
                ? t("gespeichert, aber nicht lesbar – bitte ersetzen", "stored but unreadable – please replace")
                : keyInfo.hint
                  ? t(`gespeichert · endet auf …${keyInfo.hint}`, `stored · ends in …${keyInfo.hint}`)
                  : t("gespeichert", "stored")}
            </span>
            <button type="button" className="button compact" onClick={() => setReplacing(true)}>
              {t("Ersetzen", "Replace")}
            </button>
            <button type="button" className="button compact danger" onClick={() => onKeyChange({ apiKey: null })}>
              {t("Entfernen", "Remove")}
            </button>
          </>
        ) : (
          <>
            {keyChange.apiKey === null && keyInfo.stored && <span className="setting-value">{t("wird beim Speichern entfernt", "removed when saving")}</span>}
            <input
              id={`${idPrefix}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={1000}
              placeholder={t("Schlüssel einfügen", "Paste key")}
              value={typing ? (keyChange.apiKey as string) : ""}
              onChange={(e) => onKeyChange(e.target.value ? { apiKey: e.target.value } : keyChange.apiKey === null ? { apiKey: null } : {})}
            />
          </>
        )}
      </SettingRow>
      {moved && !typing && (
        <p className="callout ai-key-note" role="note">
          {t("Anbieter oder Adresse geändert: Der gespeicherte Schlüssel wird beim Speichern gelöscht. Bitte gib ihn neu ein.", "Provider or address changed: the stored key is deleted when saving. Please enter it again.")}
        </p>
      )}
    </>
  );
}

// "Verbindung testen": address, key and model at once.
function TestButton({ url, disabled, onError }: { url: string; disabled: boolean; onError: (message: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<TestResult | null>(null);
  return (
    <div className="ai-test">
      <button
        type="button"
        className="button compact"
        disabled={disabled || busy}
        title={disabled ? t("Zuerst speichern.", "Save first.") : undefined}
        onClick={async () => {
          setBusy(true);
          setResult(null);
          try {
            setResult(await api<TestResult>(url, {}));
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t("Wird getestet …", "Testing …") : t("Verbindung testen", "Test connection")}
      </button>
      {result && (
        <span role="status" className="ai-test-result">
          {t("Verbindung steht", "Connected")} · {result.ms} ms
          {result.models.length > 0 && <> · {t(`${result.models.length} Modelle`, `${result.models.length} models`)}</>}
          {result.reply && <> · {t("Antwort", "Reply||noun")} „{result.reply}“</>}
          {!result.modelListed && <> · {t("Das Modell steht nicht in der Liste des Anbieters.", "The model is not in the provider's list.")}</>}
        </span>
      )}
    </div>
  );
}

// Ollama: installed models and downloading another one (admins).
function OllamaModels({ onPick, onError }: { onPick: (model: string) => void; onError: (message: string) => void }) {
  const t = useT();
  const [models, setModels] = useState<string[] | null>(null),
    [name, setName] = useState(""),
    [progress, setProgress] = useState<{ status: string; completed?: number; total?: number } | null>(null),
    [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      setModels((await api<{ models: string[] }>("/api/ai/admin/models", {})).models);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  async function pull() {
    setBusy(true);
    setProgress({ status: t("Startet …", "Starting …") });
    try {
      const response = await fetch("/api/ai/admin/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name.trim() }) });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(serverMessage(data.error || "Herunterladen fehlgeschlagen."));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          if (!part.trim()) continue;
          const data = JSON.parse(part);
          if (data.error) throw new Error(serverMessage(data.error));
          setProgress(data);
        }
      }
      setName("");
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const share = progress?.total ? Math.round(((progress.completed || 0) / progress.total) * 100) : null;
  return (
    <SettingRow wide label={t("Modelle in Ollama", "Models in Ollama")} description={t("Installierte Modelle anzeigen und neue herunterladen (z. B. llama3.1, qwen2.5, nomic-embed-text). Große Modelle brauchen viel Speicher und Zeit.", "Show installed models and download new ones (e.g. llama3.1, qwen2.5, nomic-embed-text). Large models need a lot of storage and time.")}>
      <div className="ai-ollama">
        <div className="ai-ollama-list">
          <button type="button" className="button compact" onClick={() => void load()}>
            {t("Installierte Modelle laden", "Load installed models")}
          </button>
          {models && models.length === 0 && <span className="muted">{t("Noch keine Modelle installiert.", "No models installed yet.")}</span>}
          {models?.map((m) => (
            <button key={m} type="button" className="button compact" title={t("Als Modell übernehmen", "Use as model")} onClick={() => onPick(m)}>
              {m}
            </button>
          ))}
        </div>
        <form
          className="ai-ollama-pull"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (name.trim()) void pull();
          }}
        >
          <input aria-label={t("Modellname", "Model name")} placeholder="llama3.1:8b" value={name} maxLength={200} disabled={busy} onChange={(e) => setName(e.target.value)} />
          <button className="button compact" disabled={busy || !name.trim()}>
            {busy ? t("Lädt herunter …", "Downloading …") : t("Modell herunterladen", "Download model")}
          </button>
        </form>
        {progress && (
          <div className="ai-progress" role="status">
            <span>
              {progress.status}
              {share !== null && ` · ${share} %`}
            </span>
            {share !== null && <progress max={100} value={share} />}
          </div>
        )}
      </div>
    </SettingRow>
  );
}

// ---- Administration → KI ----

export function AdminAi({ onError, onChange }: { onError: (message: string) => void; onChange?: () => void }) {
  const t = useT();
  const [view, setView] = useState<AdminView | null>(null),
    [draft, setDraft] = useState<InstanceAi | null>(null),
    [keyChange, setKeyChange] = useState<KeyChange>({}),
    [busy, setBusy] = useState(false),
    [formKey, setFormKey] = useState(0);
  const load = async () => {
    try {
      const next = await api<AdminView>("/api/ai/admin");
      setView(next);
      setDraft(next.settings);
      setKeyChange({});
      setFormKey((k) => k + 1);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  if (!view || !draft)
    return (
      <p className="settings-loading" role="status">
        {t("Wird geladen …", "Loading …")}
      </p>
    );
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.settings) || "apiKey" in keyChange;
  const saved = view.settings;
  const items: StatusItem[] = [saved.enabled ? { tone: "ok", label: t("KI an", "AI on") } : { tone: "off", label: t("KI aus", "AI off") }];
  if (saved.enabled) {
    items.push(
      saved.provider
        ? { tone: "info", label: t(AI_PROVIDER_NAMES[saved.provider.kind], AI_PROVIDER_NAMES_EN[saved.provider.kind]) }
        : { tone: saved.userProviders ? "info" : "warn", label: t("Kein Anbieter der Instanz", "No instance provider") },
      saved.access === "selected" ? { tone: "info", label: t(`${view.allowedUsers.length} ausgewählte Personen`, `${view.allowedUsers.length} selected people`) } : { tone: "info", label: t("Alle Personen", "Everyone") },
    );
    if (view.key.unreadable) items.push({ tone: "error", label: t("Schlüssel nicht lesbar", "Key unreadable") });
    if (saved.semanticSearch) items.push({ tone: "ok", label: t("Suche nach Bedeutung", "Semantic search") });
  }
  items.push(saved.device !== false ? { tone: "info", label: t("Auf Apple-Geräten erlaubt", "Allowed on Apple devices") } : { tone: "off", label: t("Auf Apple-Geräten aus", "Off on Apple devices") });
  const mb = (bytes: number) => (bytes / 1_048_576).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const set = (patch: Partial<InstanceAi>) => setDraft({ ...draft, ...patch });
  const provider = draft.provider;
  const local = provider?.kind === "ollama";
  return (
    <form
      key={formKey}
      className="ai-admin"
      id="ai-admin"
      aria-label={t("KI-Einstellungen der Instanz", "AI settings of the instance")}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("/api/command", { action: "admin.ai", settings: draft, ...keyChange });
          await load();
          onChange?.();
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <AdminStatus items={items} action={saved.enabled && !saved.provider && !saved.userProviders ? <FixLink href="#admin/ai/ai-provider">{t("Anbieter einrichten", "Set up provider")}</FixLink> : undefined}>
        {saved.enabled
          ? saved.provider?.kind === "ollama"
            ? t("Texte bleiben auf deinem Server.", "Text stays on your server.")
            : saved.provider
              ? t("Texte gehen an den Anbieter im Internet.", "Text goes to the provider on the internet.")
              : saved.userProviders
                ? t("Personen nutzen nur eigene Anbieter.", "People only use their own providers.")
                : t("Ohne Anbieter gibt es keine KI-Funktionen.", "Without a provider there are no AI features.")
          : saved.device !== false
            ? t("Keine KI über den Server. In den Apps auf Apple-Geräten laufen leichte KI-Aktionen auf dem Gerät (unten abschaltbar).", "No AI through the server. In the apps on Apple devices light AI actions run on the device (can be switched off below).")
            : t("Nirgends gibt es KI-Funktionen.", "There are no AI features anywhere.")}
      </AdminStatus>
      <SettingGroup
        id="ai-switch"
        title={t("Künstliche Intelligenz", "Artificial intelligence")}
        description={t(
          "Ausgeschaltet gibt es keine KI über den Server (die KI auf Apple-Geräten hat ihren eigenen Schalter, unten). Eingeschaltet gehen Texte, mit denen jemand eine KI-Funktion nutzt, an den gewählten Anbieter. Mit Ollama bleibt alles auf deinem Server.",
          "When off, there is no AI through the server (AI on Apple devices has its own switch, below). When on, text someone uses an AI feature with goes to the chosen provider. With Ollama everything stays on your server.",
        )}
      >
        <SwitchRow label={t("KI einschalten", "Turn on AI")} checked={draft.enabled} onChange={(enabled) => set({ enabled })} />
      </SettingGroup>

      <SettingGroup
        id="ai-device"
        title={t("KI auf dem Gerät (Apple)", "On-device AI (Apple)")}
        description={t(
          "Optional und standardmäßig erlaubt: In den Flowplan-Apps für iPhone, iPad und Mac mit Apple Intelligence laufen der Schreibassistent und Zusammenfassungen offener Seiten auf dem Gerät – ohne Anbieter, der Text verlässt das Gerät nicht. Jede Person kann es für sich ausschalten; für die KI gesperrte Seiten und Bereiche bleiben gesperrt, die Schalter der Funktionen und „Wer darf KI nutzen“ gelten auch hier. Ausgeschaltet fragt Flowplan die Geräte nie.",
          "Optional and allowed by default: in the Flowplan apps for iPhone, iPad and Mac with Apple Intelligence the writing assistant and summaries of open pages run on the device – no provider, the text does not leave the device. Everyone can switch it off for themselves; pages and spaces closed to the AI stay closed, the feature switches and “Who may use AI” apply here too. When off, Flowplan never asks the devices.",
        )}
      >
        <SwitchRow label={t("KI auf Apple-Geräten erlauben", "Allow AI on Apple devices")} checked={draft.device !== false} onChange={(device) => set({ device })} />
      </SettingGroup>

      <SettingGroup
        id="ai-provider"
        title={t("Anbieter der Instanz", "Instance provider")}
        description={
          provider
            ? local
              ? t("Ollama: Texte verlassen den Server nicht (sofern Ollama im eigenen Netz läuft).", "Ollama: text does not leave the server (as long as Ollama runs in your own network).")
              : t("Texte gehen an diesen Anbieter im Internet. Prüfe dessen Datenschutz- und Aufbewahrungsregeln.", "Text goes to this provider on the internet. Check its privacy and retention terms.")
            : t("Ohne Anbieter der Instanz nutzen Personen nur eigene Anbieter (falls erlaubt).", "Without an instance provider people only use their own providers (if allowed).")
        }
        actions={
          provider ? (
            <button type="button" className="button compact" onClick={() => set({ provider: null })}>
              {t("Kein Anbieter", "No provider")}
            </button>
          ) : (
            <button type="button" className="button compact" onClick={() => set({ provider: blankProvider("ollama") })}>
              {t("Anbieter einrichten", "Set up provider")}
            </button>
          )
        }
      >
        {provider && (
          <>
            <ProviderFields
              idPrefix="ai-admin"
              value={provider}
              saved={view.settings.provider}
              keyInfo={view.key}
              keyChange={keyChange}
              onChange={(next) => set({ provider: next })}
              onKeyChange={setKeyChange}
              own={false}
              models={[]}
            />
            <SettingRow label={t("Verbindung", "Connection")} description={t("Prüft Adresse, Schlüssel und Modell mit einer kurzen Anfrage.", "Checks address, key and model with a short request.")}>
              <TestButton url="/api/ai/admin/test" disabled={dirty || !view.settings.provider} onError={onError} />
            </SettingRow>
            {provider.kind === "ollama" && view.settings.provider?.kind === "ollama" && !dirty && (
              <OllamaModels onPick={(model) => set({ provider: { ...provider, model } })} onError={onError} />
            )}
          </>
        )}
        {view.env.provider && (
          <SettingRow
            label={t("Aus der Umgebung", "From the environment")}
            description={t("FLOWPLAN_AI_PROVIDER / OLLAMA_URL geben die Voreinstellung vor; gespeicherte Werte haben Vorrang. Ein Schlüssel aus FLOWPLAN_AI_API_KEY gilt nur für genau diesen Anbieter und diese Adresse.", "FLOWPLAN_AI_PROVIDER / OLLAMA_URL set the defaults; saved values take precedence. A key from FLOWPLAN_AI_API_KEY only applies to exactly this provider and address.")}
          >
            <span className="setting-value">
              {t(AI_PROVIDER_NAMES[view.env.provider.kind], AI_PROVIDER_NAMES_EN[view.env.provider.kind])} · {view.env.provider.baseUrl}
            </span>
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup id="ai-who" title={t("Wer KI nutzen darf", "Who may use AI")}>
        <SettingRow
          id="ai-access"
          label={t("Personen", "People")}
          description={
            <>
              {t("„Ausgewählte“: pro Person freischalten unter", "“Selected”: enable per person under")} <a href="#admin/users">{t("Benutzer", "Users")}</a>.
            </>
          }
        >
          <Select id="ai-access" value={draft.access} onChange={(e) => set({ access: e.target.value as InstanceAi["access"] })}>
            <option value="everyone">{t("Alle", "Everyone")}</option>
            <option value="selected">{t("Ausgewählte Personen", "Selected people")}</option>
          </Select>
        </SettingRow>
        <SwitchRow
          label={t("Auch Gäste", "Guests too")}
          description={t("Gäste sehen nur, was mit ihnen geteilt ist. Ausgeschaltet haben sie keine KI-Funktionen.", "Guests only see what is shared with them. When off, they have no AI features.")}
          checked={draft.guests}
          onChange={(guests) => set({ guests })}
        />
        <SwitchRow
          label={t("Nutzer dürfen eigene Anbieter/Schlüssel hinterlegen", "People may add their own provider/key")}
          description={t("Unabhängig vom Anbieter der Instanz: Personen nutzen dann auch ihr eigenes Konto bei einem Anbieter. Eigene Anbieter erreichen nur öffentliche https-Adressen.", "Independent of the instance provider: people can use their own account with a provider. Own providers only reach public https addresses.")}
          checked={draft.userProviders}
          onChange={(userProviders) => set({ userProviders })}
        />
      </SettingGroup>

      <SettingGroup id="ai-allowed" title={t("Funktionen", "Features")} description={t("Jede Funktion lässt sich einzeln erlauben. Personen können erlaubte Funktionen für sich ausschalten.", "Each feature can be allowed separately. People can switch allowed features off for themselves.")}>
        {AI_FEATURES.map((f) => (
          <SwitchRow
            key={f.id}
            label={t(f.label[0], f.label[1])}
            description={t(f.description[0], f.description[1])}
            checked={draft.features[f.id] !== false}
            onChange={(on) => set({ features: { ...draft.features, [f.id]: on } })}
          />
        ))}
      </SettingGroup>
      <SettingGroup
        id="ai-semantic"
        title={t("Suche nach Bedeutung", "Semantic search")}
        description={t(
          "Für „KI fragen“: Inhalte werden zusätzlich mit dem Embedding-Modell des Instanz-Anbieters als Vektoren gespeichert, damit Fragen auch ohne gleiche Wörter passende Stellen finden. Journale mit PIN, für die KI gesperrte Seiten und Bereiche sowie der Papierkorb werden nie eingebettet; persönliche KI-Regeln und Berechtigungen gelten bei jeder Frage. Speicherbedarf: 4 Byte je Dimension und Abschnitt (768 Dimensionen ≈ 3 KB je Abschnitt von bis zu ~900 Zeichen, etwa das 3- bis 4-Fache des Textes).",
          "For “Ask AI”: content is also stored as vectors with the instance provider's embedding model, so questions find matching passages without the same words. Journals with a PIN, pages and spaces closed to the AI and the trash are never embedded; personal AI rules and permissions apply to every question. Storage: 4 bytes per dimension and chunk (768 dimensions ≈ 3 KB per chunk of up to ~900 characters, roughly 3–4 times the text).",
        )}
      >
        <SwitchRow
          label={t("Suche nach Bedeutung einschalten", "Turn on semantic search")}
          description={
            !provider?.embeddingModel?.trim() || provider.kind === "anthropic"
              ? t("Braucht ein Embedding-Modell beim Anbieter der Instanz (z. B. nomic-embed-text bei Ollama). Anthropic bietet keines.", "Needs an embedding model at the instance provider (e.g. nomic-embed-text with Ollama). Anthropic has none.")
              : t(`Mit ${provider.embeddingModel}. Ausschalten löscht alle gespeicherten Vektoren.`, `With ${provider.embeddingModel}. Turning it off deletes all stored vectors.`)
          }
          checked={!!draft.semanticSearch}
          onChange={(semanticSearch) => set({ semanticSearch })}
        />
        {view.semantic && (view.semantic.active || view.semantic.chunks > 0) && (
          <SettingRow label={t("Gespeichert", "Stored")}>
            <span className="setting-value">
              {t(
                `${view.semantic.chunks} Abschnitte aus ${view.semantic.sources} Seiten und Einträgen · ${mb(view.semantic.bytes)} MB${view.semantic.pending ? ` · ${view.semantic.pending} warten` : ""}`,
                `${view.semantic.chunks} chunks from ${view.semantic.sources} pages and records · ${mb(view.semantic.bytes)} MB${view.semantic.pending ? ` · ${view.semantic.pending} waiting` : ""}`,
              )}
            </span>
          </SettingRow>
        )}
      </SettingGroup>
      <p className="muted ai-secrets-note">
        {view.secretsKey === "file"
          ? t(
              "Schlüssel werden mit AES-256-GCM verschlüsselt gespeichert, mit einem Schlüssel in secrets.key im Datenordner. Diese Datei ist nicht Teil der Instanzsicherung: Nach einer Wiederherstellung auf einem anderen Server müssen die API-Schlüssel neu eingegeben werden.",
              "Keys are stored encrypted with AES-256-GCM, using a key in secrets.key in the data folder. This file is not part of the instance backup: after restoring on another server the API keys have to be entered again.",
            )
          : t(
              "Schlüssel werden mit AES-256-GCM verschlüsselt gespeichert, abgeleitet aus dem Schlüssel in der Umgebung (FLOWPLAN_ENCRYPTION_KEY bzw. FLOWPLAN_SECRETS_KEY).",
              "Keys are stored encrypted with AES-256-GCM, derived from the key in the environment (FLOWPLAN_ENCRYPTION_KEY or FLOWPLAN_SECRETS_KEY).",
            )}
      </p>
      <SaveBar
        dirty={dirty}
        busy={busy}
        onDiscard={() => {
          setDraft(view.settings);
          setKeyChange({});
          setFormKey((k) => k + 1);
        }}
        saveLabel={t("Speichern", "Save")}
        discardLabel={t("Verwerfen", "Discard")}
        message={t("Ungespeicherte Änderungen", "Unsaved changes")}
      />
    </form>
  );
}

// Administration → Benutzer: may this person use AI ("selected people").
export function AiUserSwitch({ userId, name, allowed, onChange }: { userId: string; name: string; allowed: boolean; onChange: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <span className="ai-user-switch" title={t("Darf KI-Funktionen nutzen", "May use AI features")}>
      <small>{t("KI", "AI")}</small>
      <Switch
        checked={allowed}
        disabled={busy}
        label={t(`KI für ${name}`, `AI for ${name}`)}
        onChange={async (on) => {
          setBusy(true);
          try {
            await api("/api/command", { action: "admin.aiUser", userId, allowed: on });
            onChange();
          } finally {
            setBusy(false);
          }
        }}
      />
    </span>
  );
}

// ---- Settings → KI ----

type UserView = {
  settings: { enabled: boolean; features: Partial<Record<AiFeature, boolean>>; source: "instance" | "user"; scope: "all" | "selected"; provider: Provider | null; device: DeviceAiMode };
  key: KeyInfo;
  rules: { targetId: string; kind: "workspace" | "space" | "page"; mode: "include" | "exclude"; title: string }[];
  status: AiStatus;
  instance: { enabled: boolean; userProviders: boolean; provider: boolean; features: Record<AiFeature, boolean>; device: boolean };
};

export function UserAiSettings({ boot, onError, onRefresh }: { boot: Bootstrap; onError: (message: string) => void; onRefresh: () => Promise<unknown> }) {
  const t = useT();
  const [view, setView] = useState<UserView | null>(null);
  const load = async () => {
    try {
      setView(await api<UserView>(`/api/ai/settings?workspace=${boot.workspace.id}`));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [boot.workspace.id]);
  // Changes save at once; the state shows next to the cards' titles.
  const [saving, run] = useSaveState();
  const command = async (body: Record<string, unknown>) =>
    (await run(async () => {
      await api("/api/command", body);
      await load();
      void onRefresh().catch(() => {});
      return true;
    })) ?? false;
  if (boot.user.demo)
    return (
      <>
        <p className="muted">{t("KI über den Server ist in der Demo nicht verfügbar.", "AI through the server is not available in the demo.")}</p>
        {view && <DeviceAiSettings view={view} command={command} saving={saving} readOnly />}
      </>
    );
  if (!view)
    return (
      <p className="settings-loading" role="status">
        {t("Wird geladen …", "Loading …")}
      </p>
    );
  const { status, settings, instance } = view;
  if (!instance.enabled)
    return (
      <>
        <SettingGroup title={t("Künstliche Intelligenz", "Artificial intelligence")}>
          <SettingRow label={t("Status", "Status")} description={t("Die Administration hat KI über den Server auf dieser Instanz nicht eingeschaltet.", "The administration has not turned on AI through the server on this instance.")}>
            <span className="setting-value">{t("aus", "off")}</span>
          </SettingRow>
          {!settings.enabled && <SwitchRow label={t("KI-Funktionen verwenden", "Use AI features")} checked={false} onChange={(enabled) => void command({ action: "ai.settings", enabled })} />}
        </SettingGroup>
        <DeviceAiSettings view={view} command={command} saving={saving} />
      </>
    );
  const blocked = Object.values(status.features).find((f) => !f.ok && f.reason && !["user-off", "user-feature-off", "feature-off", "no-provider", "key-unreadable"].includes(f.reason));
  return (
    <>
      <SettingGroup
        id="ai-features"
        title={t("Künstliche Intelligenz", "Artificial intelligence")}
        actions={<SaveState status={saving} />}
        description={
          status.provider
            ? status.provider.local
              ? t("Deine Texte werden auf diesem Server verarbeitet und verlassen ihn nicht.", "Your text is processed on this server and does not leave it.")
              : t(`Texte, mit denen du eine KI-Funktion nutzt, gehen an ${status.provider.host}. Nur was du dafür auswählst und was die KI lesen darf (unten).`, `Text you use an AI feature with goes to ${status.provider.host}. Only what you choose for it and what the AI may read (below).`)
            : t("Noch kein Anbieter verfügbar.", "No provider available yet.")
        }
      >
        <SettingRow label={t("Verwendeter Anbieter", "Provider in use")}>
          <span className="setting-value">
            {aiProviderLabel(status.provider, t)}
            {status.provider && ` · ${status.provider.source === "user" ? t("dein eigener", "your own") : t("der Instanz", "the instance's")}`}
          </span>
        </SettingRow>
        {blocked?.reason && (
          <SettingRow label={t("Status", "Status")}>
            <span className="setting-value">{aiReasonText(blocked.reason, t)}</span>
          </SettingRow>
        )}
        <SwitchRow label={t("KI-Funktionen verwenden", "Use AI features")} checked={settings.enabled} onChange={(enabled) => void command({ action: "ai.settings", enabled })} />
        {settings.enabled &&
          AI_FEATURES.map((f) => (
            <SwitchRow
              key={f.id}
              label={t(f.label[0], f.label[1])}
              description={instance.features[f.id] ? t(f.description[0], f.description[1]) : t("Von der Administration ausgeschaltet.", "Switched off by the administration.")}
              disabled={!instance.features[f.id]}
              checked={instance.features[f.id] && settings.features[f.id] !== false}
              onChange={(on) => void command({ action: "ai.settings", features: { [f.id]: on } })}
            />
          ))}
      </SettingGroup>
      <DeviceAiSettings view={view} command={command} saving={saving} />
      {(instance.userProviders || settings.provider) && <OwnProvider key={`${JSON.stringify(settings.provider)}:${view.key.stored}:${view.key.hint}`} view={view} command={command} onError={onError} />}
      <AiAccessRules boot={boot} view={view} command={command} saving={saving} />
    </>
  );
}

// "Auf diesem Gerät (Apple)": whether Apple Intelligence runs here (asked
// from the app's bridge) and how the person wants it – optional, "when
// possible" by default, off means the page never asks the device.
function DeviceAiSettings({
  view,
  command,
  saving,
  readOnly = false,
}: {
  view: UserView;
  command: (b: Record<string, unknown>) => Promise<boolean>;
  saving: ReturnType<typeof useSaveState>[0];
  readOnly?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const state = useDeviceAi(view.instance.device);
  const reason = view.instance.device ? deviceReason(state, locale === "en" || locale === "fr" ? locale : "de") : null;
  const [lineDe, lineEn] = DEVICE_REASON_TEXT[reason || "available"];
  const off = !view.settings.enabled;
  const mode: DeviceAiMode = off ? "off" : view.settings.device;
  return (
    <SettingGroup
      id="ai-device"
      title={t("Auf diesem Gerät (Apple)", "On this device (Apple)")}
      actions={readOnly ? undefined : <SaveState status={saving} />}
      description={t(
        "Optional: In den Flowplan-Apps für iPhone, iPad und Mac kann Apple Intelligence den Schreibassistenten und Zusammenfassungen offener Seiten direkt auf dem Gerät ausführen – der Text verlässt das Gerät nicht, auch nicht in verschlüsselten Bereichen. Fragen an den Arbeitsbereich, KI in Datenbanken und KI-Aktionen laufen weiter auf dem Server.",
        "Optional: in the Flowplan apps for iPhone, iPad and Mac, Apple Intelligence can run the writing assistant and summaries of open pages right on the device – the text does not leave the device, also in encrypted spaces. Asking the workspace, AI in databases and AI actions keep running on the server.",
      )}
    >
      {!view.instance.device ? (
        <SettingRow label={t("Status", "Status")} description={t("Die Administration hat KI auf dem Gerät für diese Instanz ausgeschaltet.", "The administration has switched off on-device AI for this instance.")}>
          <span className="setting-value">{t("aus", "off")}</span>
        </SettingRow>
      ) : (
        <>
          <SettingRow label={t("Apple Intelligence auf diesem Gerät", "Apple Intelligence on this device")}>
            <span className="setting-value" data-device-ai={reason || "available"}>
              {t(lineDe, lineEn)}
            </span>
          </SettingRow>
          <SettingRow
            id="ai-device-mode"
            label={t("KI auf dem Gerät verwenden", "Use on-device AI")}
            description={
              readOnly
                ? t("In der Demo gilt die Standardeinstellung.", "The demo uses the default.")
                : off
                  ? t("KI-Funktionen sind oben ausgeschaltet – auch auf dem Gerät.", "AI features are switched off above – on the device too.")
                  : mode === "prefer"
                    ? t("Standard. Schreibassistent und Zusammenfassungen laufen auf dem Gerät, wenn es kann – sonst auf dem Server, falls dort KI verfügbar ist.", "Default. The writing assistant and summaries run on the device when it can – otherwise on the server, if AI is available there.")
                    : mode === "fallback"
                      ? t("Auf dem Gerät nur, wenn der Server keine KI anbietet (und in verschlüsselten Bereichen).", "On the device only when the server offers no AI (and in encrypted spaces).")
                      : t("Aus: Flowplan fragt das Gerät nie nach KI.", "Off: Flowplan never asks the device for AI.")
            }
          >
            <Select id="ai-device-mode" value={mode} disabled={readOnly || off} onChange={(e) => void command({ action: "ai.settings", device: e.target.value })}>
              <option value="prefer">{t("Wenn möglich (Standard)", "When possible (default)")}</option>
              <option value="fallback">{t("Nur ohne KI auf dem Server", "Only without AI on the server")}</option>
              <option value="off">{t("Aus", "Off")}</option>
            </Select>
          </SettingRow>
        </>
      )}
    </SettingGroup>
  );
}

function OwnProvider({ view, command, onError }: { view: UserView; command: (b: Record<string, unknown>) => Promise<boolean>; onError: (m: string) => void }) {
  const t = useT();
  const saved = view.settings.provider;
  const [draft, setDraft] = useState<Provider | null>(saved),
    [keyChange, setKeyChange] = useState<KeyChange>({}),
    [busy, setBusy] = useState(false),
    [formKey, setFormKey] = useState(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || "apiKey" in keyChange;
  return (
    <form
      key={formKey}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await command({ action: "ai.provider", provider: draft, ...keyChange });
        setBusy(false);
        if (ok) {
          setKeyChange({});
          setFormKey((k) => k + 1);
        }
      }}
    >
      <SettingGroup
        title={t("Eigener Anbieter", "Own provider")}
        description={t(
          "Dein eigenes Konto bei einem KI-Anbieter, mit deinem Schlüssel. Der Schlüssel wird verschlüsselt gespeichert, nie angezeigt und nur an genau diese Adresse gesendet; ändert sich die Adresse, wird er gelöscht.",
          "Your own account with an AI provider, with your key. The key is stored encrypted, never shown and only sent to exactly this address; if the address changes, it is deleted.",
        )}
        actions={
          draft ? (
            <button type="button" className="button compact" onClick={() => setDraft(null)}>
              {t("Entfernen", "Remove")}
            </button>
          ) : view.instance.userProviders ? (
            <button type="button" className="button compact" onClick={() => setDraft(blankProvider("openai"))}>
              {t("Eigenen Anbieter einrichten", "Set up own provider")}
            </button>
          ) : null
        }
      >
        {!view.instance.userProviders && <p className="callout">{t("Eigene Anbieter sind auf dieser Instanz nicht mehr erlaubt.", "Own providers are no longer allowed on this instance.")}</p>}
        {draft && (
          <>
            <ProviderFields idPrefix="ai-own" value={draft} saved={saved} keyInfo={view.key} keyChange={keyChange} onChange={setDraft} onKeyChange={setKeyChange} own models={[]} />
            <SettingRow label={t("Verbindung", "Connection")}>
              <TestButton url="/api/ai/test" disabled={dirty || !saved} onError={onError} />
            </SettingRow>
          </>
        )}
        {saved && view.instance.provider && (
          <SettingRow id="ai-source" label={t("Welchen Anbieter verwenden", "Which provider to use")}>
            <Select id="ai-source" value={view.settings.source} onChange={(e) => void command({ action: "ai.settings", source: e.target.value })}>
              <option value="instance">{t("Den der Instanz", "The instance's")}</option>
              <option value="user">{t("Meinen eigenen", "My own")}</option>
            </Select>
          </SettingRow>
        )}
      </SettingGroup>
      <SaveBar
        dirty={dirty}
        busy={busy}
        onDiscard={() => {
          setDraft(saved);
          setKeyChange({});
          setFormKey((k) => k + 1);
        }}
        saveLabel={t("Speichern", "Save")}
        discardLabel={t("Verwerfen", "Discard")}
        message={t("Ungespeicherte Änderungen", "Unsaved changes")}
      />
    </form>
  );
}

// "Worauf die KI zugreifen darf": everything I may see, or only what I
// include; plus rules for the workspace, spaces, pages and databases.
function AiAccessRules({ boot, view, command, saving }: { boot: Bootstrap; view: UserView; command: (b: Record<string, unknown>) => Promise<boolean>; saving: ReturnType<typeof useSaveState>[0] }) {
  const t = useT();
  const [target, setTarget] = useState(""),
    [mode, setMode] = useState<"include" | "exclude">("exclude");
  // The workspace, its spaces and their pages as an indented list.
  const options = useMemo(() => {
    const pages = boot.pages.filter((p) => !p.deleted_at && !p.journal_date);
    const children = new Map<string, typeof pages>();
    for (const p of pages) {
      const key = p.parent_id && pages.some((q) => q.id === p.parent_id) ? p.parent_id : `space:${p.space_id}`;
      children.set(key, [...(children.get(key) || []), p]);
    }
    const out: { id: string; label: string }[] = [{ id: boot.workspace.id, label: `${t("Arbeitsbereich", "Workspace")}: ${boot.workspace.name}` }];
    const walk = (key: string, depth: number) => {
      for (const p of children.get(key) || []) {
        if (depth > 12) return;
        out.push({ id: p.id, label: `${" ".repeat(depth)}${p.title || t("Ohne Titel", "Untitled")}${p.kind === "database" ? ` (${t("Datenbank", "Database")})` : ""}` });
        walk(p.id, depth + 1);
      }
    };
    for (const s of boot.spaces.filter((s) => !s.deleted_at)) {
      out.push({ id: s.id, label: `${t("Bereich", "Space")}: ${s.name}` });
      walk(`space:${s.id}`, 1);
    }
    return out;
  }, [boot.pages, boot.spaces, boot.workspace, t]);
  return (
    <SettingGroup
      id="ai-access"
      title={t("Worauf die KI zugreifen darf", "What the AI may access")}
      actions={<SaveState status={saving} />}
      description={t(
        "Die KI liest nie mehr, als du selbst sehen darfst. Gesperrte Seiten, Journale mit PIN, private Einträge anderer und der Papierkorb sind immer ausgeschlossen. Regeln gelten für Unterseiten und Einträge mit; die nächstgelegene Regel gewinnt.",
        "The AI never reads more than you may see yourself. Pages closed to the AI, journals with a PIN, other people's private records and the trash are always excluded. Rules apply to sub-pages and records too; the closest rule wins.",
      )}
    >
      <SettingRow id="ai-scope" label={t("Grundsatz", "Default")}>
        <Select id="ai-scope" value={view.settings.scope} onChange={(e) => void command({ action: "ai.settings", scope: e.target.value })}>
          <option value="all">{t("Alles, was ich sehen darf", "Everything I may see")}</option>
          <option value="selected">{t("Nur ausgewählte", "Only selected")}</option>
        </Select>
      </SettingRow>
      {view.rules.length === 0 && (
        <div className="setting-row wide">
          <EmptyState title={t("Noch keine Regeln", "No rules yet")}>{t("Es gilt der Grundsatz oben.", "The default above applies.")}</EmptyState>
        </div>
      )}
      {view.rules.map((rule) => (
        <SettingRow
          key={rule.targetId}
          label={rule.title || t("Ohne Titel", "Untitled")}
          description={rule.kind === "workspace" ? t("Arbeitsbereich", "Workspace") : rule.kind === "space" ? t("Bereich", "Space") : t("Seite mit Unterseiten", "Page with sub-pages")}
        >
          <span className="setting-value">{rule.mode === "include" ? t("erlaubt", "allowed") : t("ausgeschlossen", "excluded")}</span>
          <button type="button" className="button compact" onClick={() => void command({ action: "ai.rule", targetId: rule.targetId, mode: null })}>
            {t("Entfernen", "Remove")}
          </button>
        </SettingRow>
      ))}
      <SettingRow wide label={t("Regel hinzufügen", "Add rule")}>
        <div className="ai-rule-add">
          <Select aria-label={t("Arbeitsbereich, Bereich oder Seite", "Workspace, space or page")} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t("Auswählen …", "Choose …")}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Erlauben oder ausschließen", "Allow or exclude")} value={mode} onChange={(e) => setMode(e.target.value as "include" | "exclude")}>
            <option value="exclude">{t("Ausschließen", "Exclude")}</option>
            <option value="include">{t("Erlauben", "Allow")}</option>
          </Select>
          <button
            type="button"
            className="button compact"
            disabled={!target}
            onClick={async () => {
              if (await command({ action: "ai.rule", targetId: target, mode })) setTarget("");
            }}
          >
            {t("Hinzufügen", "Add")}
          </button>
        </div>
      </SettingRow>
    </SettingGroup>
  );
}

// "Für KI gesperrt" for a page (share dialog) or a space (space settings).
export function AiBlockToggle({ targetId, kind, onError }: { targetId: string; kind: "page" | "space"; onError: (message: string) => void }) {
  const t = useT();
  const [info, setInfo] = useState<{ blocked: boolean; inherited: "space" | "page" | null; canManage: boolean; enabled: boolean } | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api<NonNullable<typeof info>>(`/api/ai/block?target=${targetId}&kind=${kind}`)
      .then((r) => alive && setInfo(r))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [targetId, kind]);
  if (!info || (!info.enabled && !info.blocked)) return null;
  return (
    <div className="ai-block">
      {info.canManage ? (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={info.blocked}
            disabled={busy}
            onChange={async (e) => {
              setBusy(true);
              try {
                setInfo({ ...info, ...(await api<typeof info>("/api/command", { action: "ai.block", targetId, kind, blocked: e.target.checked })) });
              } catch (err) {
                onError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
          <span>
            {t("Für KI gesperrt", "Closed to AI")}
            <small>
              {kind === "page"
                ? t("Für alle: Keine KI-Funktion liest diese Seite, ihre Unterseiten und Einträge.", "For everyone: no AI feature reads this page, its sub-pages and records.")
                : t("Für alle: Keine KI-Funktion liest Seiten und Einträge dieses Bereichs.", "For everyone: no AI feature reads pages and records of this space.")}
            </small>
          </span>
        </label>
      ) : info.blocked ? (
        <p className="muted">{t("Für KI gesperrt.", "Closed to AI.")}</p>
      ) : null}
      {info.inherited && (
        <p className="muted">
          {info.inherited === "space"
            ? t("Der Bereich dieser Seite ist für KI gesperrt.", "The space of this page is closed to AI.")
            : t("Eine übergeordnete Seite ist für KI gesperrt.", "A parent page is closed to AI.")}
        </p>
      )}
    </div>
  );
}
