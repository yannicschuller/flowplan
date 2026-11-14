"use client";
// Settings → Konto & Sicherheit → Notfallzugriff (#281, lib/emergency-access.ts):
// the trusted contacts one named (add, waiting period, deny a request, end
// an access, remove), the people who named oneself ("Ich bin
// Vertrauensperson für …": accept, ask for access, withdraw, give up the
// role) and – once access is granted – a read-only view of the holder's
// private spaces with the Markdown/ZIP export. Encrypted pages are
// decrypted in this tab with the keys the holder's browser sealed for us.
import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { DownloadSimple, LockKey } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api, download, downloadBlob, Modal } from "./ui";
import { Select } from "./select";
import { CONTROL, SettingGroup, SettingRow, StatusBadge } from "./settings-ui";
import { openEmergencyKeys, sealEmergencyKeys, useE2ee, loadIdentity } from "./e2ee-store";
import * as e2ee from "@/lib/e2ee";
import { documentMarkdown, type JsonNode } from "@/lib/e2ee-markdown";
import { LOCALE_TAG } from "@/lib/locale-tag";
import {
  EMERGENCY_ACCESS_DAYS,
  EMERGENCY_DEFAULT_WAIT,
  EMERGENCY_WAIT_DAYS,
  type EmergencyContent,
  type EmergencyContactView,
  type EmergencyHolderView,
  type EmergencyOverview,
  type EmergencyPage,
} from "@/lib/emergency-kinds";
import { exportName } from "@/lib/export-name";

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(LOCALE_TAG, { dateStyle: "medium", timeStyle: "short" }) : "");

export function EmergencyAccessSettings({ userId, onError }: { userId: string; onError: (message: string) => void }) {
  const t = useT();
  const e2eeState = useE2ee();
  const [data, setData] = useState<EmergencyOverview | null>(null),
    [email, setEmail] = useState(""),
    [wait, setWait] = useState(EMERGENCY_DEFAULT_WAIT),
    [access, setAccess] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<EmergencyHolderView | null>(null),
    [viewing, setViewing] = useState<EmergencyHolderView | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<EmergencyOverview>("/api/emergency"));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => {
    void load();
    void loadIdentity(userId).catch(() => {});
  }, [load, userId]);
  // Keys my contacts still wait for: sealed while I am unlocked.
  const pending = data?.rewrap.length || 0;
  useEffect(() => {
    if (!pending || !e2eeState.unlocked || !data) return;
    void sealEmergencyKeys(data.rewrap)
      .then((n) => (n ? load() : undefined))
      .catch((e) => onError((e as Error).message));
  }, [pending, e2eeState.unlocked]);
  const act = async (input: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api("/api/command", input);
      await load();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!data)
    return (
      <SettingGroup id="emergency" title={t("Notfallzugriff", "Emergency access")}>
        <SettingRow label={t("Status", "Status")}>
          <span className="settings-loading" role="status">
            {t("Wird geladen …", "Loading …")}
          </span>
        </SettingRow>
      </SettingGroup>
    );
  const contactStatus = (c: EmergencyContactView) =>
    c.status === "invited" ? (
      <StatusBadge tone="off">{t("Noch nicht bestätigt", "Not confirmed yet")}</StatusBadge>
    ) : c.status === "accepted" ? (
      <StatusBadge tone="ok">{t("Bereit", "Ready")}</StatusBadge>
    ) : c.status === "requested" ? (
      <StatusBadge tone="warn">{t(`Anfrage – Zugriff ab ${when(c.grantAt)}`, `Request – access from ${when(c.grantAt)}`)}</StatusBadge>
    ) : (
      <StatusBadge tone="error">{t("Hat Lesezugriff", "Has read access")}</StatusBadge>
    );
  return (
    <SettingGroup
      id="emergency"
      title={t("Notfallzugriff", "Emergency access")}
      description={t(
        "Vertrauenspersonen können im Notfall deine privaten Bereiche lesen und exportieren – erst nach einer Wartezeit, in der du jede Anfrage ablehnen kannst. Niemand übernimmt dein Konto; ändern oder löschen kann niemand etwas.",
        "Trusted contacts can read and export your private spaces in an emergency – only after a waiting period in which you can deny any request. Nobody takes over your account; nobody can change or delete anything.",
      )}
      actions={!data.enabled ? <StatusBadge tone="off">{t("Von der Administration ausgeschaltet", "Switched off by the administration")}</StatusBadge> : undefined}
    >
      <SettingRow
        wide
        label={t("Deine Vertrauenspersonen", "Your trusted contacts")}
        description={t(
          "Enthalten sind nur Bereiche, die dir gehören und privat sind – keine Teambereiche, keine Inhalte, die du nur über einen Arbeitsbereich siehst, keine Journale mit PIN.",
          "Only spaces you own that are private are included – no team spaces, nothing you only see through a workspace, no journals with a PIN.",
        )}
      >
        <ul className="emergency-list">
          {data.mine.length === 0 && <li className="emergency-empty">{t("Noch niemand eingetragen.", "Nobody added yet.")}</li>}
          {data.mine.map((c) => (
            <li key={c.id} className="emergency-item">
              <span className="emergency-who">
                <strong>{c.contact.name}</strong>
                <small>
                  {c.contact.email} · {t(`${c.waitDays} Tage Wartezeit`, `${c.waitDays} days waiting period`)}
                  {c.accessDays ? ` · ${t(`Zugriff für ${c.accessDays} Tage`, `access for ${c.accessDays} days`)}` : ""}
                </small>
                {data.encryptedSpaces > 0 && !c.contact.hasKeys && (
                  <small>{t("Verschlüsselte Bereiche kommen dazu, sobald diese Person die Verschlüsselung einrichtet.", "Encrypted spaces are added once this person sets up encryption.")}</small>
                )}
                {c.keysMissing > 0 && c.contact.hasKeys && (
                  <small>
                    <LockKey size={13} aria-hidden />{" "}
                    {t(
                      "Entsperre deine Verschlüsselung, damit deine verschlüsselten Bereiche für diese Person eingeschlossen werden.",
                      "Unlock your encryption so your encrypted spaces are included for this person.",
                    )}
                  </small>
                )}
              </span>
              {contactStatus(c)}
              <span className="emergency-actions">
                {c.status === "requested" && (
                  <button className="button compact danger" disabled={busy} onClick={() => void act({ action: "emergency.deny", linkId: c.id })}>
                    {t("Ablehnen", "Deny")}
                  </button>
                )}
                {c.status === "granted" && (
                  <button className="button compact danger" disabled={busy} onClick={() => void act({ action: "emergency.revoke", linkId: c.id })}>
                    {t("Zugriff beenden", "End access")}
                  </button>
                )}
                <button className="button compact" disabled={busy} onClick={() => void act({ action: "emergency.remove", linkId: c.id })}>
                  {t("Entfernen", "Remove")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </SettingRow>
      {data.enabled && (
        <SettingRow
          wide
          label={t("Vertrauensperson hinzufügen", "Add a trusted contact")}
          description={t(
            "Die E-Mail-Adresse eines Kontos auf dieser Instanz. Die Person muss die Rolle annehmen.",
            "The e-mail address of an account on this instance. The person has to accept the role.",
          )}
        >
          <form
            className="emergency-add"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act({ action: "emergency.designate", email, waitDays: wait, accessDays: access })) setEmail("");
            }}
          >
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("E-Mail-Adresse", "E-mail address")} aria-label={t("E-Mail-Adresse", "E-mail address")} />
            <Select className={CONTROL.sm} aria-label={t("Wartezeit", "Waiting period")} value={wait} onChange={(e) => setWait(Number(e.target.value))}>
              {EMERGENCY_WAIT_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? t("1 Tag Wartezeit", "1 day waiting period") : t(`${d} Tage Wartezeit`, `${d} days waiting period`)}
                </option>
              ))}
            </Select>
            <Select className={CONTROL.sm} aria-label={t("Dauer des Zugriffs", "Length of access")} value={access ?? ""} onChange={(e) => setAccess(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t("Bis du ihn beendest", "Until you end it")}</option>
              {EMERGENCY_ACCESS_DAYS.map((d) => (
                <option key={d} value={d}>
                  {t(`${d} Tage lang`, `For ${d} days`)}
                </option>
              ))}
            </Select>
            <button className="button primary" type="submit" disabled={busy || !email.trim()}>
              {t("Hinzufügen", "Add")}
            </button>
          </form>
        </SettingRow>
      )}
      {data.forMe.length > 0 && (
        <SettingRow wide label={t("Ich bin Vertrauensperson für …", "I am a trusted contact for …")}>
          <ul className="emergency-list">
            {data.forMe.map((h) => (
              <li key={h.id} className="emergency-item">
                <span className="emergency-who">
                  <strong>{h.holder.name}</strong>
                  <small>
                    {h.holder.email} · {t(`${h.waitDays} Tage Wartezeit`, `${h.waitDays} days waiting period`)}
                  </small>
                  {h.status === "requested" && <small>{t(`Angefragt – Zugriff ab ${when(h.grantAt)}, wenn nicht abgelehnt.`, `Requested – access from ${when(h.grantAt)} unless denied.`)}</small>}
                  {h.status === "granted" && h.expiresAt && <small>{t(`Zugriff bis ${when(h.expiresAt)}`, `Access until ${when(h.expiresAt)}`)}</small>}
                  {h.requestAfter && <small>{t(`Abgelehnt. Eine neue Anfrage ist ab ${when(h.requestAfter)} möglich.`, `Denied. A new request is possible from ${when(h.requestAfter)}.`)}</small>}
                </span>
                <span className="emergency-actions">
                  {h.status === "invited" && data.enabled && (
                    <button className="button compact primary" disabled={busy} onClick={() => void act({ action: "emergency.accept", linkId: h.id })}>
                      {t("Annehmen", "Accept")}
                    </button>
                  )}
                  {h.status === "accepted" && data.enabled && (
                    <button className="button compact" disabled={busy || !!h.requestAfter} onClick={() => setConfirm(h)}>
                      {t("Notfallzugriff anfragen", "Request emergency access")}
                    </button>
                  )}
                  {h.status === "requested" && (
                    <button className="button compact" disabled={busy} onClick={() => void act({ action: "emergency.cancel", linkId: h.id })}>
                      {t("Anfrage zurückziehen", "Withdraw request")}
                    </button>
                  )}
                  {h.status === "granted" && data.enabled && (
                    <button className="button compact primary" onClick={() => setViewing(h)}>
                      {t("Inhalte öffnen", "Open content")}
                    </button>
                  )}
                  <button className="button compact" disabled={busy} onClick={() => void act({ action: "emergency.leave", linkId: h.id })}>
                    {h.status === "invited" ? t("Ablehnen", "Decline") : t("Rolle abgeben", "Give up role")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </SettingRow>
      )}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={t("Notfallzugriff anfragen?", "Request emergency access?")}
        actions={
          <>
            <button className="button" onClick={() => setConfirm(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                if (confirm && (await act({ action: "emergency.request", linkId: confirm.id }))) setConfirm(null);
              }}
            >
              {t("Anfragen", "Request")}
            </button>
          </>
        }
      >
        {confirm && (
          <p>
            {t(
              `${confirm.holder.name} wird sofort benachrichtigt – in Flowplan, per E-Mail, Push und Chat-App – und erneut vor Ablauf der Wartezeit. Lehnt ${confirm.holder.name} nicht innerhalb von ${confirm.waitDays} Tagen ab, kannst du ihre bzw. seine privaten Bereiche lesen und exportieren. Alles, was du dabei tust, wird protokolliert.`,
              `${confirm.holder.name} is told right away – in Flowplan, by e-mail, push and chat app – and again before the waiting period ends. Unless ${confirm.holder.name} denies within ${confirm.waitDays} days, you can read and export their private spaces. Everything you do there is logged.`,
            )}
          </p>
        )}
      </Modal>
      {viewing && <EmergencyViewer link={viewing} onClose={() => setViewing(null)} onError={onError} />}
    </SettingGroup>
  );
}

type Shown = { page: EmergencyPage; markdown: string; title: string };

// The holder's content, read-only: a list of pages per space and the page
// as Markdown; plaintext spaces export as ZIP, encrypted pages as Markdown
// decrypted here.
function EmergencyViewer({ link, onClose, onError }: { link: EmergencyHolderView; onClose: () => void; onError: (message: string) => void }) {
  const t = useT();
  const e2eeState = useE2ee();
  const [content, setContent] = useState<EmergencyContent | null>(null),
    [keys, setKeys] = useState<Map<string, Map<number, e2ee.SpaceKey>> | null>(null),
    [titles, setTitles] = useState<Map<string, string>>(new Map()),
    [shown, setShown] = useState<Shown | null>(null),
    [loading, setLoading] = useState(false);
  const base = `/api/emergency/${link.id}`;
  useEffect(() => {
    void api<EmergencyContent>(`${base}/content`)
      .then(setContent)
      .catch((e) => onError((e as Error).message));
  }, [base]);
  const encrypted = useMemo(() => new Set(content?.spaces.filter((s) => s.encrypted).map((s) => s.id) || []), [content]);
  // Encrypted spaces: the keys sealed for me, once I am unlocked.
  useEffect(() => {
    if (!encrypted.size || !e2eeState.unlocked || keys) return;
    void (async () => {
      try {
        const opened = await openEmergencyKeys(await api(`${base}/keys`));
        setKeys(opened);
        const names = new Map<string, string>();
        for (const page of content!.pages)
          if (page.titleCipher && opened.has(page.spaceId))
            try {
              names.set(page.id, await e2ee.decryptTitle((v) => opened.get(page.spaceId)!.get(v), page.id, page.titleCipher));
            } catch {}
        setTitles(names);
      } catch (e) {
        onError((e as Error).message);
      }
    })();
  }, [encrypted.size, e2eeState.unlocked]);
  const titleOf = (page: EmergencyPage) => titles.get(page.id) || page.title || t("Ohne Titel", "Untitled");
  const open = async (page: EmergencyPage) => {
    setLoading(true);
    try {
      if (!encrypted.has(page.spaceId)) {
        const result = await api<{ markdown: string; title: string }>(`${base}/pages/${page.id}`);
        setShown({ page, markdown: result.markdown, title: result.title });
        return;
      }
      const spaceKeys = keys?.get(page.spaceId);
      if (!spaceKeys) throw new Error(t("Für diesen Bereich fehlt der Schlüssel.", "The key of this space is missing."));
      const doc = new Y.Doc();
      let after = 0;
      for (;;) {
        const log = await api<{ snapshot: { upto: number; version: number; data: string } | null; updates: { seq: number; version: number; data: string }[]; more: boolean }>(
          `${base}/pages/${page.id}/log?after=${after}`,
        );
        const decrypt = async (purpose: "update" | "snapshot", version: number, data: string) => {
          const key = spaceKeys.get(version);
          if (!key) throw new Error(t("Für diesen Bereich fehlt der Schlüssel.", "The key of this space is missing."));
          return e2ee.decryptContent(key, e2ee.fromBase64(data), e2ee.contentContext(purpose, page.id, version));
        };
        if (log.snapshot) Y.applyUpdate(doc, await decrypt("snapshot", log.snapshot.version, log.snapshot.data));
        for (const u of log.updates) Y.applyUpdate(doc, await decrypt("update", u.version, u.data));
        after = log.updates.at(-1)?.seq ?? log.snapshot?.upto ?? after;
        if (!log.more) break;
      }
      const title = titleOf(page);
      setShown({ page, title, markdown: documentMarkdown(yDocToProsemirrorJSON(doc, "default") as JsonNode, title) });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const exportSpace = async (spaceId: string, name: string) => {
    try {
      const r = await fetch(`${base}/export?space=${spaceId}`, { cache: "no-store" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || t("Export fehlgeschlagen.", "Export failed."));
      downloadBlob(`${exportName(name) || "flowplan"}.zip`, await r.blob());
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const depth = (page: EmergencyPage) => {
    let n = 0,
      current = page;
    const byId = new Map(content!.pages.map((p) => [p.id, p]));
    while (current.parentId && byId.has(current.parentId) && n < 8) {
      current = byId.get(current.parentId)!;
      n++;
    }
    return n;
  };
  return (
    <Modal open onClose={onClose} wide title={t(`Notfallzugriff: Inhalte von ${link.holder.name}`, `Emergency access: content of ${link.holder.name}`)}>
      <p className="emergency-note">
        {t(
          "Nur lesen und exportieren. Alles, was du hier öffnest oder exportierst, wird protokolliert und der Kontoinhaberin bzw. dem Kontoinhaber angezeigt.",
          "Read and export only. Everything you open or export here is logged and shown to the account holder.",
        )}
      </p>
      {!content ? (
        <p role="status">{t("Wird geladen …", "Loading …")}</p>
      ) : (
        <div className="emergency-viewer">
          <nav className="emergency-tree" aria-label={t("Seiten", "Pages")}>
            {content.spaces.length === 0 && <p>{t("Keine privaten Bereiche.", "No private spaces.")}</p>}
            {content.spaces.map((space) => (
              <section key={space.id}>
                <h3>
                  {space.name} <small>{space.workspace}</small>
                </h3>
                {space.encrypted ? (
                  !e2eeState.unlocked && (
                    <p className="emergency-note">
                      <LockKey size={13} aria-hidden />{" "}
                      {t("Verschlüsselt: entsperre deine Verschlüsselung (Einstellungen → Konto & Sicherheit), um ihn zu lesen.", "Encrypted: unlock your encryption (Settings → Account & security) to read it.")}
                    </p>
                  )
                ) : (
                  <button className="button compact" onClick={() => void exportSpace(space.id, space.name)}>
                    <DownloadSimple size={14} aria-hidden /> {t("Als ZIP exportieren", "Export as ZIP")}
                  </button>
                )}
                <ul>
                  {content.pages
                    .filter((p) => p.spaceId === space.id)
                    .map((p) => (
                      <li key={p.id} className={`emergency-depth-${Math.min(depth(p), 6)}`}>
                        <button className={`emergency-page${shown?.page.id === p.id ? " active" : ""}`} disabled={loading || (space.encrypted && !keys)} onClick={() => void open(p)}>
                          {titleOf(p)}
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </nav>
          <article className="emergency-content">
            {shown ? (
              <>
                <header>
                  <h3>{shown.title}</h3>
                  <button className="button compact" onClick={() => download(`${exportName(shown.title) || "flowplan"}.md`, shown.markdown, "text/markdown")}>
                    <DownloadSimple size={14} aria-hidden /> {t("Als Markdown herunterladen", "Download as Markdown")}
                  </button>
                </header>
                <pre className="emergency-markdown">{shown.markdown}</pre>
              </>
            ) : (
              <p className="emergency-note">{t("Wähle links eine Seite.", "Choose a page on the left.")}</p>
            )}
          </article>
        </div>
      )}
    </Modal>
  );
}
