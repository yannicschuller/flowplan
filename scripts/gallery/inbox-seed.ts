// Example notifications for the inbox scenes of the gallery: a mix of
// every group – mentions, comments, a task, a share, a reminder, an approval,
// security incidents (two alike, collapsed into one row) and an older text –
// today, yesterday and last week, some read. Written straight into the
// database of the gallery's own server (only people made up for it; the
// server has no second account to cause them), the way the places that
// notify write them (lib/notification-fields.ts).
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

type Refs = { language?: "de" | "en"; userId: string; documentId: string; databaseId: string; workflowId: string; rowId?: string | null; documentTitle: string; rowTitle?: string };
type Seed = {
  kind: string | null;
  body: string;
  minutesAgo: number;
  read?: boolean;
  page?: string | null;
  row?: string | null;
  link?: string | null;
  subtype?: string;
  severity?: string;
  params?: Record<string, string>;
  excerpt?: string;
};

export function inboxExamples(r: Refs): Seed[] {
  // The made-up texts in the language of the screens.
  const de = r.language === "de";
  const x = (german: string, english: string) => (de ? german : english);
  const H = 60;
  const D = 24 * H;
  return [
    {
      kind: "incident",
      body: "Sicherheitsvorfall: Abtasten von Adressen und IDs – 60 × 401/403/404, z. B. 403 /api/ai/block. Details unter Einstellungen → Instanz → Sicherheit.",
      minutesAgo: 12,
      link: `#settings/instance/threats/incident/${randomUUID()}`,
      subtype: "incident",
      severity: "warn",
      params: { rule: "probing", detail: x("60 × 401/403/404, z. B. 403 /api/ai/block", "60 × 401/403/404, e.g. 403 /api/ai/block") },
    },
    {
      kind: "mention",
      body: `Jonas Weber hat dich in einem Kommentar in „${r.documentTitle}“ erwähnt`,
      minutesAgo: 25,
      page: r.documentId,
      subtype: "comment_mention",
      params: { actor: "Jonas Weber", page: r.documentTitle },
      excerpt: x("@Mara kannst du die Budgetzahlen bis Freitag prüfen? Der März sieht seltsam aus.", "@Mara could you check the budget figures before Friday? The March numbers look off."),
    },
    {
      kind: "workflow_ops",
      body: "Freigabe erbeten – Invoices: Invoice of €4,800 from Nordlicht GmbH",
      minutesAgo: 48,
      page: r.workflowId,
      subtype: "approval",
      params: { workflow: x("Rechnungen", "Invoices"), message: x("Rechnung über 4.800 € von Nordlicht GmbH für den Website-Relaunch", "Invoice of €4,800 from Nordlicht GmbH for the website relaunch") },
    },
    {
      kind: "incident",
      body: "Sicherheitsvorfall: Abtasten von Adressen und IDs – 41 × 401/403/404. Details unter Einstellungen → Instanz → Sicherheit.",
      minutesAgo: 95,
      link: `#settings/instance/threats/incident/${randomUUID()}`,
      subtype: "incident",
      severity: "warn",
      params: { rule: "probing", detail: x("41 × 401/403/404, z. B. 404 /api/pages/…/export", "41 × 401/403/404, e.g. 404 /api/pages/…/export") },
    },
    {
      kind: "comment",
      body: `Lea Hoffmann kommentiert „${r.documentTitle}“`,
      minutesAgo: 130,
      read: true,
      page: r.documentId,
      subtype: "comment",
      params: { actor: "Lea Hoffmann", page: r.documentTitle },
      excerpt: x("Sieht gut aus – ich habe die Druckkosten in die Tabelle eingetragen.", "Looks good to me – I added the print costs to the table."),
    },
    {
      kind: "mention",
      body: `Aylin Demir hat dir eine Aufgabe in „${r.documentTitle}“ gegeben: ${x("Budget für März mit dem Controlling abstimmen", "Align the March budget with finance")}`,
      minutesAgo: 170,
      page: r.documentId,
      subtype: "assignment",
      params: { actor: "Aylin Demir", page: r.documentTitle, task: x("Budget für März mit dem Controlling abstimmen", "Align the March budget with finance") },
    },
    {
      kind: "incident",
      body: "Kritischer Sicherheitsvorfall: Anmeldung nach vielen Fehlversuchen – 23 Fehlversuche. Details unter Einstellungen → Instanz → Sicherheit.",
      minutesAgo: 13 * H,
      link: `#settings/instance/threats/incident/${randomUUID()}`,
      subtype: "incident",
      severity: "critical",
      params: { rule: "login_after_failures", detail: x("admin@example.test, 23 Fehlversuche, dann angemeldet", "admin@example.test, 23 failures, then signed in") },
    },
    {
      kind: "share",
      body: `Tobias Klein hat „${r.documentTitle}“ mit dir geteilt`,
      minutesAgo: 16 * H,
      read: true,
      page: r.documentId,
      subtype: "share",
      params: { actor: "Tobias Klein", page: r.documentTitle },
    },
    {
      kind: "reminder",
      body: `Erinnerung: „${r.rowTitle || "Launch"}“ – ${x("Fällig", "Due")}: 16.10.2026`,
      minutesAgo: 19 * H,
      page: r.databaseId,
      row: r.rowId || null,
      subtype: "date_reminder",
      params: { record: r.rowTitle || "Launch", field: x("Fällig", "Due"), date: "16.10.2026" },
    },
    {
      kind: "mention",
      body: `Lea Hoffmann hat dich in „${r.documentTitle}“ erwähnt`,
      minutesAgo: 3 * D + 2 * H,
      read: true,
      page: r.documentId,
      subtype: "mention",
      params: { actor: "Lea Hoffmann", page: r.documentTitle },
    },
    // An older notification of a kind with text only.
    {
      kind: "ai_quota",
      body: x("KI-Kontingent der Instanz: 80 % des Monatsbudgets verbraucht.", "AI quota of the instance: 80 % of this month's budget used."),
      minutesAgo: 8 * D,
      read: true,
      link: "#settings/instance/ai/quotas",
    },
  ];
}

// `now`: the moment the screens show (the gallery's fixed time).
export function seedInboxNotifications(dataDir: string, refs: Refs, now: Date) {
  const sqlite = new DatabaseSync(join(dataDir, "flowplan.sqlite"));
  try {
    const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
    const insert = sqlite.prepare(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind,link,created_at,read_at,actor_id,subtype,severity,params,excerpt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const s of inboxExamples(refs))
      insert.run(
        randomUUID(),
        refs.userId,
        s.body,
        s.page ?? null,
        s.row ?? null,
        s.kind,
        s.link ?? null,
        at(s.minutesAgo),
        s.read ? at(s.minutesAgo) : null,
        null,
        s.subtype ?? null,
        s.severity ?? null,
        s.params ? JSON.stringify(s.params) : null,
        s.excerpt ?? null,
      );
  } finally {
    sqlite.close();
  }
}
