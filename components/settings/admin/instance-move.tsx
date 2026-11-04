"use client";
// Administration → Speicher & Sicherung → Instanz umziehen (lib/instance-move.ts):
// on the old instance "Umzug vorbereiten" (move token, read-only, "moved
// to" banner); on the new one "Von anderer Instanz übernehmen" – first
// copy with progress, pre-flight check, last state with the source
// read-only, and the hand-over to the restore on the next start.
import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, Truck } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { PreflightItem } from "@/lib/instance-move";
import type { MoveProgress } from "@/lib/instance-move-pull";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { DangerZone, SettingGroup, SettingRow, StatusBadge, SwitchRow } from "../../settings-ui";
import { FreshSecret } from "../../integration-settings";
import { bytes } from "../../admin-storage";
import { useDocs } from "./parts";

type SourceStatus = {
  token: { id: string; createdAt: number; expiresAt: number; lastUsedAt: number | null; usedAt: number | null; revokedAt: number | null; active: boolean } | null;
  readOnly: boolean;
  readOnlyAt: number | null;
  movedTo: string | null;
  redirect: boolean;
};
type TargetStatus = {
  allowPrivate: boolean;
  content: { users: number; workspaces: number; pages: number; files: number; fresh: boolean };
  incoming: { source: string; startedAt: number; firstCopyAt: number | null; finalAt: number | null; stagedAt: number | null; error: string | null } | null;
  job: { kind: "copy" | "final"; progress: MoveProgress | null } | null;
};
type Status = { source: SourceStatus; target: TargetStatus; stepUp: "password" | "recent-sign-in" };

const when = (ms: number) => new Date(ms).toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" });

export function InstanceMove({ onChange, onError }: { onChange: () => Promise<void>; onError: (message: string) => void }) {
  const t = useT();
  const guide = useDocs()("move-instance");
  const [status, setStatus] = useState<Status | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/admin/instance-move"));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => void load(), [load]);
  // While a transfer runs: its progress every second.
  const running = !!status?.target.job;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [running, load]);
  const act = async (body: Record<string, unknown>) => {
    const result = await api<Partial<Status> & Record<string, unknown>>("/api/admin/instance-move", body);
    setStatus((s) => (s ? { ...s, ...(result.source ? { source: result.source } : {}), ...(result.target ? { target: result.target } : {}) } : s));
    return result;
  };
  if (!status) return null;
  return (
    <>
      <SettingGroup
        id="instance-move"
        title={t("Instanz umziehen", "Move instance")}
        description={
          <>
            {t(
              "Die ganze Instanz auf einen anderen Server bringen, direkt von Server zu Server: Datenbank, Dateien und Schlüssel. Die neue Instanz holt alles mit einem Umzugstoken dieser Instanz.",
              "Move the whole instance to another server, directly from server to server: database, files and keys. The new instance fetches everything with a move token from this instance.",
            )}{" "}
            <a href={guide} target="_blank" rel="noreferrer">
              {t("Anleitung", "Guide")}
            </a>
          </>
        }
      >
        <SourceSide status={status} act={act} onError={onError} />
      </SettingGroup>
      <TargetSide status={status} act={act} load={load} onChange={onChange} onError={onError} />
    </>
  );
}

type Act = (body: Record<string, unknown>) => Promise<Partial<Status> & Record<string, unknown>>;

// The old instance: token, read-only state, "moved to".
function SourceSide({ status, act, onError }: { status: Status; act: Act; onError: (m: string) => void }) {
  const t = useT();
  const s = status.source;
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; url: string; expiresAt: number } | null>(null);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      return await act(body);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const prepare = async () => {
    const result = await run({ action: "prepare", password });
    if (result?.token) {
      setFresh({ token: String(result.token), url: String(result.url), expiresAt: Number(result.expiresAt) });
      setAsking(false);
      setPassword("");
    }
  };
  const token = s.token;
  return (
    <>
      {s.movedTo ? (
        <>
          <SettingRow
            label={t("Umgezogen", "Moved")}
            description={t(`Diese Instanz ist umgezogen nach ${s.movedTo}. Sie ist schreibgeschützt; alle sehen einen Hinweis mit der neuen Adresse.`, `This instance has moved to ${s.movedTo}. It is read-only; everyone sees a notice with the new address.`)}
          >
            <StatusBadge tone="info">{t("Umgezogen", "Moved")}</StatusBadge>
          </SettingRow>
          <SwitchRow
            label={t("Weboberfläche weiterleiten", "Redirect the web interface")}
            description={t("Wer diese Instanz im Browser öffnet, landet direkt auf der neuen Adresse.", "Whoever opens this instance in the browser goes straight to the new address.")}
            checked={s.redirect}
            disabled={busy}
            onChange={(on) => void run({ action: "redirect", on })}
          />
        </>
      ) : (
        <SettingRow
          label={t("Umzug vorbereiten", "Prepare the move")}
          description={`${t(
            "Erzeugt ein Umzugstoken für die neue Instanz: einmal sichtbar, 24 Stunden gültig, jederzeit widerrufbar. Es erlaubt nur das Lesen der Instanz für den Umzug.",
            "Creates a move token for the new instance: visible once, valid for 24 hours, revocable at any time. It only allows reading the instance for the move.",
          )} ${status.stepUp === "password" ? t("Zur Sicherheit mit deinem Passwort bestätigen.", "Confirm with your password for safety.") : t("Zur Sicherheit muss deine Anmeldung höchstens 15 Minuten alt sein.", "For safety, your sign-in must be at most 15 minutes old.")}`}
        >
          {!asking && (
            <button type="button" className="button" disabled={busy} onClick={() => (status.stepUp === "password" ? setAsking(true) : void prepare())}>
              <Truck size={16} aria-hidden /> {token?.active ? t("Neues Token", "New token") : t("Umzug vorbereiten", "Prepare the move")}
            </button>
          )}
        </SettingRow>
      )}
      {asking && (
        <form
          method="post"
          action="/api/auth/no-script"
          className="setting-row wide move-step-up"
          onSubmit={(e) => {
            e.preventDefault();
            void prepare();
          }}
        >
          <label htmlFor="move-password">{t("Passwort bestätigen", "Confirm password")}</label>
          <div className="move-inline">
            <input id="move-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoFocus />
            <button type="submit" className="button primary" disabled={busy || !password}>
              {t("Token erzeugen", "Create token")}
            </button>
            <button type="button" className="button" onClick={() => setAsking(false)}>
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </form>
      )}
      {fresh && (
        <div className="setting-row wide move-fresh">
          <dl className="move-facts">
            <dt>{t("Übertragungsadresse", "Transfer address")}</dt>
            <dd>
              <code>{fresh.url}</code>
            </dd>
            <dt>{t("Gültig bis", "Valid until")}</dt>
            <dd>{when(fresh.expiresAt)}</dd>
          </dl>
          <FreshSecret label={t("Umzugstoken", "Move token")} value={fresh.token} />
          <small>
            {t(
              "Auf der neuen Instanz unter Administration → Speicher & Sicherung → Von anderer Instanz übernehmen eintragen, oder dort ausführen: ",
              "Enter it on the new instance under Administration → Storage & backup → Take over from another instance, or run there: ",
            )}
            <code>npm run move -- --from {fresh.url} --token …</code>
          </small>
        </div>
      )}
      {token && !fresh && !s.movedTo && (
        <SettingRow
          label={t("Umzugstoken", "Move token")}
          description={[
            t(`erstellt ${when(token.createdAt)}`, `created ${when(token.createdAt)}`),
            token.revokedAt
              ? t(`widerrufen ${when(token.revokedAt)}`, `revoked ${when(token.revokedAt)}`)
              : token.usedAt
                ? t(`verbraucht ${when(token.usedAt)}`, `used up ${when(token.usedAt)}`)
                : token.active
                  ? t(`gültig bis ${when(token.expiresAt)}`, `valid until ${when(token.expiresAt)}`)
                  : t("abgelaufen", "expired"),
            token.lastUsedAt ? t(`zuletzt benutzt ${when(token.lastUsedAt)}`, `last used ${when(token.lastUsedAt)}`) : t("noch nicht benutzt", "not used yet"),
          ].join(" · ")}
        >
          <StatusBadge tone={token.active ? "ok" : "off"}>{token.active ? t("Aktiv", "Active") : t("Ungültig", "Invalid")}</StatusBadge>
          {token.active && (
            <button type="button" className="button" disabled={busy} onClick={() => void run({ action: "revoke" })}>
              {t("Widerrufen", "Revoke")}
            </button>
          )}
        </SettingRow>
      )}
      {fresh && token?.active && (
        <SettingRow label={t("Umzugstoken", "Move token")} description={t("Nicht mehr gebraucht oder in falsche Hände geraten?", "No longer needed or in the wrong hands?")}>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={async () => {
              await run({ action: "revoke" });
              setFresh(null);
            }}
          >
            {t("Widerrufen", "Revoke")}
          </button>
        </SettingRow>
      )}
      {(s.readOnly || s.movedTo) && (
        <SettingRow
          label={t("Schreibschutz", "Read-only")}
          description={
            s.movedTo
              ? t("Den Hinweis entfernen und die Instanz wieder beschreibbar machen – nur, wenn der Umzug rückgängig gemacht wird.", "Remove the notice and make the instance writable again – only when the move is undone.")
              : t(
                  `Seit ${s.readOnlyAt ? when(s.readOnlyAt) : "dem letzten Abgleich"} schreibgeschützt für den letzten Abgleich. Lesen und Anmelden gehen weiter.`,
                  `Read-only since ${s.readOnlyAt ? when(s.readOnlyAt) : "the last sync"} for the final sync. Reading and signing in still work.`,
                )
          }
        >
          <button type="button" className="button" disabled={busy} onClick={() => void run({ action: "unfreeze" })}>
            {t("Schreibschutz aufheben", "Lift read-only")}
          </button>
        </SettingRow>
      )}
    </>
  );
}

function ProgressView({ progress, kind }: { progress: MoveProgress | null; kind: "copy" | "final" }) {
  const t = useT();
  const share = progress && progress.bytesTotal ? Math.min(1, progress.bytesDone / progress.bytesTotal) : 0;
  const phase = !progress
    ? t("Verbindet …", "Connecting …")
    : {
        manifest: t("Quelle erstellt den Datenbankstand und prüft die Dateien …", "The source creates the database snapshot and checks the files …"),
        database: t("Datenbank", "Database"),
        files: t("Dateien", "Files"),
        extras: t("Schlüssel", "Keys"),
        done: t("Fertig", "Done"),
      }[progress.phase];
  const eta = progress?.etaSeconds ?? null;
  const left = eta === null || eta <= 0 ? "" : eta >= 3600 ? `${Math.floor(eta / 3600)} h ${Math.round((eta % 3600) / 60)} min` : eta >= 60 ? `${Math.round(eta / 60)} min` : `${eta} s`;
  return (
    <div className="move-progress" role="status" aria-live="polite">
      <div className="move-progress-head">
        <strong>{kind === "copy" ? t("Erste Kopie", "First copy") : t("Letzter Stand", "Last state")}</strong>
        <span>{phase}</span>
      </div>
      <span className="admin-usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t("Fortschritt", "Progress")}>
        <span style={{ width: `${Math.max(2, share * 100)}%` }} />
      </span>
      {progress && progress.phase !== "manifest" && (
        <small>
          {bytes(progress.bytesDone)} / {bytes(progress.bytesTotal)} · {progress.filesDone} / {progress.filesTotal} {t("Dateien", "files")}
          {left ? ` · ${t(`noch etwa ${left}`, `about ${left} left`)}` : ""}
        </small>
      )}
    </div>
  );
}

// The new instance: pull, check, last state, apply.
function TargetSide({ status, act, load, onChange, onError }: { status: Status; act: Act; load: () => Promise<void>; onChange: () => Promise<void>; onError: (m: string) => void }) {
  const t = useT();
  const target = status.target;
  const incoming = target.incoming;
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<{ checkedAt: number; items: PreflightItem[] } | null>(null);
  const [applied, setApplied] = useState<{ notified: boolean } | null>(null);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      return await act(body);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const job = target.job;
  const step = (done: boolean, active: boolean) => <StatusBadge tone={done ? "ok" : active ? "info" : "off"}>{done ? t("Erledigt", "Done") : active ? t("Läuft", "Running") : t("Offen", "Open")}</StatusBadge>;
  return (
    <DangerZone
      id="move-in"
      title={t("Von anderer Instanz übernehmen", "Take over from another instance")}
      description={t(
        "Holt eine ganze Instanz auf diesen Server. Gedacht für eine neue, leere Instanz: Alles hier wird beim nächsten Neustart ersetzt, der bisherige Stand bleibt als „pre-move-…“ im Datenordner. Danach meldest du dich mit den Konten der alten Instanz an.",
        "Fetches a whole instance onto this server. Meant for a new, empty instance: everything here is replaced on the next restart; the previous state stays in the data folder as “pre-move-…”. Afterwards you sign in with the accounts of the old instance.",
      )}
    >
      {!incoming ? (
        <form
          method="post"
          action="/api/auth/no-script"
          className="setting-row wide move-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "start", url, token, confirm });
          }}
        >
          <label htmlFor="move-url">{t("Adresse der alten Instanz", "Address of the old instance")}</label>
          <input id="move-url" type="url" inputMode="url" placeholder="https://flowplan.example.org" value={url} onChange={(e) => setUrl(e.currentTarget.value)} required />
          <label htmlFor="move-token">{t("Umzugstoken", "Move token")}</label>
          <input id="move-token" type="password" autoComplete="off" spellCheck={false} placeholder="fpmove_…" value={token} onChange={(e) => setToken(e.currentTarget.value)} required />
          {!target.allowPrivate && (
            <small>
              {t(
                "Adressen im eigenen Netz (LAN, VPN, z. B. 192.168.… oder 10.…) und http:// sind nur mit FLOWPLAN_MOVE_ALLOW_PRIVATE=true auf dieser Instanz erlaubt.",
                "Addresses in your own network (LAN, VPN, e.g. 192.168.… or 10.…) and http:// are only allowed with FLOWPLAN_MOVE_ALLOW_PRIVATE=true on this instance.",
              )}
            </small>
          )}
          {!target.content.fresh && (
            <label className="move-confirm">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.currentTarget.checked)} />
              <span>
                {t(
                  `Diese Instanz ist nicht leer (${target.content.users} Konten, ${target.content.workspaces} Arbeitsbereiche, ${target.content.pages} Seiten, ${target.content.files} Dateien). Ich verstehe, dass alles ersetzt wird.`,
                  `This instance is not empty (${target.content.users} accounts, ${target.content.workspaces} workspaces, ${target.content.pages} pages, ${target.content.files} files). I understand that everything is replaced.`,
                )}
              </span>
            </label>
          )}
          <div className="move-inline">
            <button type="submit" className="button danger" disabled={busy || !url || !token || (!target.content.fresh && !confirm)}>
              {busy ? t("Verbindet …", "Connecting …") : t("Übernahme starten", "Start the takeover")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <SettingRow label={t("Quelle", "Source")} description={t(`${incoming.source} · begonnen ${when(incoming.startedAt)}`, `${incoming.source} · started ${when(incoming.startedAt)}`)}>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                await run({ action: "cancel" });
                setChecks(null);
                setApplied(null);
              }}
            >
              {t("Umzug abbrechen", "Cancel the move")}
            </button>
          </SettingRow>
          {job && (
            <div className="setting-row wide">
              <ProgressView progress={job.progress} kind={job.kind} />
            </div>
          )}
          {!job && (incoming.error || !incoming.firstCopyAt) && (
            <SettingRow
              label={t("Unterbrochen", "Interrupted")}
              description={<span role="alert">{incoming.error || t("Die Übertragung wurde unterbrochen, etwa durch einen Neustart. Sie geht dort weiter, wo sie stand.", "The transfer was interrupted, for example by a restart. It continues where it stopped.")}</span>}
            >
              <button type="button" className="button primary" disabled={busy} onClick={() => void run({ action: "resume" })}>
                <ArrowsClockwise size={16} aria-hidden /> {t("Fortsetzen", "Resume")}
              </button>
            </SettingRow>
          )}
          <SettingRow
            label={t("1. Erste Kopie", "1. First copy")}
            description={
              incoming.firstCopyAt
                ? t(`Fertig ${when(incoming.firstCopyAt)}. Die alte Instanz läuft weiter wie bisher.`, `Done ${when(incoming.firstCopyAt)}. The old instance keeps running as before.`)
                : t("Datenbankstand, alle Dateien (mit Prüfsumme) und die Schlüssel der Instanz. Bricht die Verbindung ab, geht es an derselben Stelle weiter.", "Database snapshot, every file (with checksum) and the instance's keys. If the connection drops, it continues where it stopped.")
            }
          >
            {step(!!incoming.firstCopyAt, job?.kind === "copy")}
          </SettingRow>
          <SettingRow
            label={t("2. Vorabprüfung", "2. Pre-flight check")}
            description={t(
              "Vergleicht die Einstellungen beider Instanzen – nur Namen und Prüfwerte, nie die Werte – und prüft, ob diese Instanz S3, SMTP und OIDC erreicht.",
              "Compares the settings of both instances – only names and check values, never the values – and checks whether this instance reaches S3, SMTP and OIDC.",
            )}
          >
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                const result = await run({ action: "preflight" });
                if (result?.items) setChecks(result as unknown as { checkedAt: number; items: PreflightItem[] });
              }}
            >
              {checks ? t("Erneut prüfen", "Check again") : t("Prüfen", "Check")}
            </button>
          </SettingRow>
          {checks && <PreflightList items={checks.items} />}
          <SettingRow
            label={t("3. Quelle schreibschützen und letzten Stand holen", "3. Make the source read-only and fetch the last state")}
            description={
              incoming.finalAt
                ? t(`Fertig ${when(incoming.finalAt)}. Die alte Instanz ist schreibgeschützt.`, `Done ${when(incoming.finalAt)}. The old instance is read-only.`)
                : t(
                    "Ab hier beginnt die Ausfallzeit: Die alte Instanz nimmt keine Änderungen mehr an (Lesen geht weiter), diese Instanz holt den neuen Datenbankstand und nur neue oder geänderte Dateien – meist Minuten.",
                    "Downtime starts here: the old instance accepts no more changes (reading still works); this instance fetches the new database snapshot and only new or changed files – usually minutes.",
                  )
            }
          >
            {incoming.finalAt || job?.kind === "final" ? (
              step(!!incoming.finalAt, job?.kind === "final")
            ) : (
              <button type="button" className="button primary" disabled={busy || !!job || !incoming.firstCopyAt} onClick={() => void run({ action: "final" })}>
                {t("Schreibschützen und holen", "Make read-only and fetch")}
              </button>
            )}
          </SettingRow>
          <SettingRow
            label={t("4. Beim Neustart übernehmen", "4. Apply on restart")}
            description={
              incoming.stagedAt || applied
                ? `${t("Bereit. Jetzt den Server (Container) neu starten.", "Ready. Restart the server (container) now.")} ${
                    applied && !applied.notified
                      ? t("Die alte Instanz konnte nicht benachrichtigt werden; sie bleibt schreibgeschützt ohne Hinweis auf die neue Adresse.", "The old instance could not be notified; it stays read-only without a notice of the new address.")
                      : t("Die alte Instanz zeigt jetzt die neue Adresse; ihr Umzugstoken ist verbraucht.", "The old instance now shows the new address; its move token is used up.")
                  }`
                : t(
                    "Prüft die Datenbank und übernimmt alles beim nächsten Neustart wie eine Wiederherstellung. Danach den DNS-Eintrag auf diesen Server umstellen.",
                    "Checks the database and applies everything on the next restart, like a restore. Then point the DNS record to this server.",
                  )
            }
          >
            {incoming.stagedAt || applied ? (
              <StatusBadge tone="ok">{t("Bereit", "Ready")}</StatusBadge>
            ) : (
              <button
                type="button"
                className="button danger"
                disabled={busy || !!job || !incoming.finalAt}
                onClick={async () => {
                  const result = await run({ action: "apply" });
                  if (result) {
                    setApplied({ notified: !!result.notified });
                    await load();
                    await onChange();
                  }
                }}
              >
                {t("Übernehmen", "Apply")}
              </button>
            )}
          </SettingRow>
        </>
      )}
    </DangerZone>
  );
}

// The pre-flight check as a list: ok, warning, error – each with what it
// means for the move.
function PreflightList({ items }: { items: PreflightItem[] }) {
  const t = useT();
  const groups: Record<string, string> = {
    oidc: t("OIDC-Anmeldung", "OIDC sign-in"),
    s3: t("S3-Speicher und Litestream", "S3 storage and Litestream"),
    smtp: t("E-Mail (SMTP)", "E-mail (SMTP)"),
    push: t("Push und Apps", "Push and apps"),
    ai: t("KI", "AI"),
    other: t("Weitere Einstellungen", "Other settings"),
  };
  const list = (names?: string[]) => (names || []).join(", ");
  const text = (item: PreflightItem): [string, string] => {
    const { source = "", target = "", message = "" } = item;
    switch (item.code) {
      case "schema.same":
        return [t("Version", "Version"), t(`Gleiche Datenbankversion (Schema ${source}).`, `Same database version (schema ${source}).`)];
      case "schema.newer":
        return [t("Version", "Version"), t(`Diese Instanz ist neuer (Schema ${target} statt ${source}); die Daten werden beim Start angepasst.`, `This instance is newer (schema ${target} instead of ${source}); the data is updated on start.`)];
      case "schema.older":
        return [t("Version", "Version"), t(`Diese Instanz ist älter als die Quelle (Schema ${target} statt ${source}). Zuerst diese Instanz auf dieselbe oder eine neuere Version bringen.`, `This instance is older than the source (schema ${target} instead of ${source}). Update this instance to the same or a newer version first.`)];
      case "encryption.none":
        return ["FLOWPLAN_ENCRYPTION_KEY", t("Auf beiden Instanzen nicht gesetzt.", "Not set on either instance.")];
      case "encryption.same":
        return ["FLOWPLAN_ENCRYPTION_KEY", t("Gleicher Schlüssel.", "Same key.")];
      case "encryption.previous":
        return ["FLOWPLAN_ENCRYPTION_KEY", t("Der Schlüssel der Quelle steht hier in FLOWPLAN_ENCRYPTION_KEY_PREVIOUS – alles bleibt lesbar.", "The source's key is in FLOWPLAN_ENCRYPTION_KEY_PREVIOUS here – everything stays readable.")];
      case "encryption.missing":
      case "encryption.differs":
        return [
          "FLOWPLAN_ENCRYPTION_KEY",
          `${item.code === "encryption.missing" ? t("Fehlt auf dieser Instanz.", "Missing on this instance.") : t("Ein anderer Schlüssel als auf der Quelle.", "A different key than on the source.")} ${t(
            "Dann sind verschlüsselte Sicherungen (.enc und im Bucket), die verschlüsselten Dateien im S3-Speicher, gespeicherte Tokens und Kalenderverbindungen unlesbar. Den Schlüssel der Quelle hier setzen (einen neuen höchstens zusätzlich, die alten in …_PREVIOUS).",
            "Encrypted backups (.enc and in the bucket), the encrypted files in S3 storage, stored tokens and calendar connections then become unreadable. Set the source's key here (a new one only in addition, the old ones in …_PREVIOUS).",
          )}`,
        ];
      case "encryption.added":
        return ["FLOWPLAN_ENCRYPTION_KEY", t("Nur diese Instanz hat einen Schlüssel: Neue Sicherungen werden verschlüsselt. Gespeicherte Geheimnisse der Quelle prüft die nächste Zeile.", "Only this instance has a key: new backups are encrypted. The next line checks the source's stored secrets.")];
      case "secrets.same":
        return [t("Gespeicherte Geheimnisse", "Stored secrets"), t("API-Schlüssel, Kalender- und Chat-Verbindungen und Zwei-Faktor-Geheimnisse bleiben lesbar.", "API keys, calendar and chat connections and two-factor secrets stay readable.")];
      case "secrets.file":
        return [t("Gespeicherte Geheimnisse", "Stored secrets"), t("Die Quelle nutzt den erzeugten Schlüssel secrets.key; er kommt mit dem Umzug mit.", "The source uses the generated key secrets.key; it comes along with the move.")];
      case "secrets.missing":
        return [
          t("Gespeicherte Geheimnisse", "Stored secrets"),
          t(
            "Der Schlüssel dafür (FLOWPLAN_SECRETS_KEY oder FLOWPLAN_ENCRYPTION_KEY der Quelle) fehlt hier. Gespeicherte Tokens, KI-Schlüssel, Kalender- und Chat-Verbindungen werden unlesbar, Konten mit Zwei-Faktor-Anmeldung kommen nicht mehr hinein. Den Schlüssel der Quelle hier setzen.",
            "Their key (FLOWPLAN_SECRETS_KEY or FLOWPLAN_ENCRYPTION_KEY of the source) is missing here. Stored tokens, AI keys, calendar and chat connections become unreadable, and accounts with two-factor sign-in can no longer get in. Set the source's key here.",
          ),
        ];
      case "url.same":
        return ["APP_URL", t(`Gleiche Adresse (${source}): Passkeys, Apps, CalDAV, Webhooks und Freigabelinks funktionieren nach dem DNS-Wechsel weiter.`, `Same address (${source}): passkeys, apps, CalDAV, webhooks and share links keep working after the DNS switch.`)];
      case "url.differs":
        return [
          "APP_URL",
          t(
            `Andere Adresse: ${source || "?"} → ${target || "?"}. Passkeys sind an die Domain gebunden und müssen neu angelegt werden; die OIDC-Weiterleitungsadresse beim Anbieter ändern; CalDAV- und CardDAV-Konten, die Server-Adresse in den Apps, eingehende Webhooks (Git, Tickets, E-Mail) und Freigabelinks zeigen noch auf die alte Adresse. Besser die Domain behalten.`,
            `Different address: ${source || "?"} → ${target || "?"}. Passkeys are bound to the domain and must be created again; change the OIDC redirect address at the provider; CalDAV and CardDAV accounts, the server address in the apps, incoming webhooks (Git, tickets, e-mail) and share links still point to the old address. Better keep the domain.`,
          ),
        ];
      case "s3.same-bucket":
        return [
          t("Gleicher Bucket", "Same bucket"),
          t(
            "Beide Instanzen nutzen denselben Bucket und Ordner. Mit Litestream schreiben dann beide hinein: die alte Instanz vor dem Start der neuen stoppen oder hier einen anderen S3_PREFIX wählen. Alternativ startet die neue Instanz mit leerem Datenordner direkt aus dem Bucket (Weg c der Anleitung).",
            "Both instances use the same bucket and folder. With Litestream both would write into it: stop the old instance before starting the new one, or choose another S3_PREFIX here. Alternatively the new instance starts from the bucket with an empty data folder (way c of the guide).",
          ),
        ];
      case "reach.s3.off":
        return ["S3", t("Kein S3-Speicher auf dieser Instanz – alles liegt lokal im Datenordner.", "No S3 storage on this instance – everything is local in the data folder.")];
      case "reach.s3.ok":
        return ["S3", t("Bucket von hier erreichbar.", "Bucket reachable from here.")];
      case "reach.s3.replica":
        return ["S3", t("Bucket erreichbar, mit einer Litestream-Kopie der Datenbank: Diese Instanz könnte auch direkt aus dem Bucket starten.", "Bucket reachable, with a Litestream copy of the database: this instance could also start straight from the bucket.")];
      case "reach.s3.error":
        return ["S3", t(`Bucket nicht erreichbar: ${message}`, `Bucket not reachable: ${message}`)];
      case "reach.smtp.off":
        return ["SMTP", t("Kein SMTP eingerichtet – Einladungen und Benachrichtigungen per E-Mail gehen nicht raus.", "No SMTP set up – invitations and e-mail notifications are not sent.")];
      case "reach.smtp.ok":
        return ["SMTP", t(`${target} erreichbar.`, `${target} reachable.`)];
      case "reach.smtp.port":
        return ["SMTP", t(`${target} nicht erreichbar: ${message}. Viele Anbieter (z. B. Hetzner) sperren ausgehend die Ports 25 und 465 – Port 587 mit STARTTLS verwenden.`, `${target} not reachable: ${message}. Many providers (e.g. Hetzner) block outgoing ports 25 and 465 – use port 587 with STARTTLS.`)];
      case "reach.smtp.error":
        return ["SMTP", t(`${target} nicht erreichbar: ${message}`, `${target} not reachable: ${message}`)];
      case "reach.oidc.off":
        return ["OIDC", t("Keine OIDC-Anmeldung eingerichtet.", "No OIDC sign-in set up.")];
      case "reach.oidc.ok":
        return ["OIDC", t(`Anbieter ${target} erreichbar.`, `Provider ${target} reachable.`)];
      case "reach.oidc.error":
        return ["OIDC", t(`Anbieter nicht erreichbar: ${message}`, `Provider not reachable: ${message}`)];
    }
    if (item.code.startsWith("env.")) {
      const parts = [
        item.missing?.length ? t(`fehlt hier: ${list(item.missing)}`, `missing here: ${list(item.missing)}`) : "",
        item.differs?.length ? t(`anderer Wert: ${list(item.differs)}`, `different value: ${list(item.differs)}`) : "",
        item.added?.length ? t(`nur hier: ${list(item.added)}`, `only here: ${list(item.added)}`) : "",
      ].filter(Boolean);
      return [groups[item.code.slice(4)] || item.code, parts.length ? parts.join(" · ") : t(`Gleich: ${list(item.names)}`, `Same: ${list(item.names)}`)];
    }
    return [item.code, message];
  };
  const tone = { ok: "ok", warn: "warn", error: "error" } as const;
  const label = { ok: t("OK", "OK"), warn: t("Warnung", "Warning"), error: t("Fehler", "Error") };
  const counts = { error: items.filter((i) => i.level === "error").length, warn: items.filter((i) => i.level === "warn").length };
  return (
    <div className="setting-row wide">
      <p className="move-summary" role="status">
        {counts.error
          ? t(`${counts.error} Fehler – vor dem Umschalten beheben.`, `${counts.error} errors – fix them before switching.`)
          : counts.warn
            ? t(`Keine Fehler, ${counts.warn} Warnungen.`, `No errors, ${counts.warn} warnings.`)
            : t("Alles in Ordnung.", "Everything is fine.")}
      </p>
      <ul className="move-checks">
        {items.map((item) => {
          const [title, detail] = text(item);
          return (
            <li key={item.id} className={`move-check ${item.level}`}>
              <StatusBadge tone={tone[item.level]}>{label[item.level]}</StatusBadge>
              <div>
                <strong>{title}</strong>
                <span>{detail}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
