// E-mail over SMTP: invitations and a summary of unread notifications.
// Messages go into a persistent queue (like push) and are sent by a worker
// with retries, so a slow or failing mail server never blocks a request.
// Without SMTP_HOST nothing is queued or sent.
import nodemailer, { type Transporter } from "nodemailer";
import { all, id, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { instanceSettings } from "./instance-settings";

export type MailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
};

export function mailConfig(): MailConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    host,
    port,
    // Port 465 speaks TLS from the start; others upgrade with STARTTLS.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    from: process.env.SMTP_FROM || `Flowplan <${process.env.SMTP_USER || "flowplan@localhost"}>`,
  };
}

type Sender = (message: { to: string; subject: string; text: string; html: string }) => Promise<unknown>;
const runtime = globalThis as unknown as {
  flowplanMailTransport?: Transporter;
  flowplanMailRun?: Promise<void>;
  flowplanMailTimer?: ReturnType<typeof setInterval>;
  flowplanMailSender?: Sender;
};

function transport(config: MailConfig) {
  runtime.flowplanMailTransport ??= nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return runtime.flowplanMailTransport;
}

// Tests replace the SMTP connection with their own function.
export function setMailSender(sender: Sender | undefined) {
  runtime.flowplanMailSender = sender;
}
function send(config: MailConfig, message: { to: string; subject: string; text: string; html: string }) {
  if (runtime.flowplanMailSender) return runtime.flowplanMailSender(message);
  return transport(config).sendMail({ from: config.from, ...message });
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const instanceName = () => instanceSettings().name || "Flowplan";

// Plain, readable HTML: one column, the brand colour for the button.
function layout(title: string, paragraphs: string[], action?: { label: string; url: string }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`).join("");
  const button = action
    ? `<p style="margin:22px 0"><a href="${escape(action.url)}" style="background:#3b3fd8;color:#ffffff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escape(action.label)}</a></p>`
    : "";
  return `<!doctype html><html lang="de"><body style="margin:0;background:#f6f4ef;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1c22"><div style="max-width:520px;margin:0 auto;padding:32px 20px"><p style="font-weight:700;font-size:15px;margin:0 0 20px;color:#3b3fd8">${escape(instanceName())}</p><h1 style="font-size:21px;margin:0 0 16px">${escape(title)}</h1>${body}${button}<p style="margin:28px 0 0;font-size:12px;color:#8a8691">Diese E-Mail kommt von ${escape(appUrl())}. Benachrichtigungen per E-Mail stellst du in Flowplan unter Einstellungen → Benachrichtigungen ein.</p></div></body></html>`;
}

export function queueMail(to: string, subject: string, text: string, html: string) {
  if (!mailConfig() || !/^[^\s@]+@[^\s@]+$/.test(to)) return false;
  run(
    "INSERT INTO mail_queue(id,recipient,subject,text,html,next_at) VALUES(?,?,?,?,?,?)",
    id(),
    to,
    subject.slice(0, 250),
    text,
    html,
    Date.now(),
  );
  return true;
}

// Account e-mails with one link: confirm the address, reset the password.
export function queueLinkMail(input: {
  to: string;
  subject: string;
  title: string;
  lines: string[];
  label: string;
  url: string;
}) {
  const text = `${input.lines.join("\n\n")}\n\n${input.url}\n`;
  const html = layout(input.title, input.lines.map(escape), { label: input.label, url: input.url });
  return queueMail(input.to, input.subject, text, html);
}

export function queueInviteMail(input: {
  email: string;
  inviter: string;
  workspace: string;
  guest: boolean;
}) {
  const url = appUrl();
  const role = input.guest ? "als Gast " : "";
  const subject = `${input.inviter} hat dich ${role}zu „${input.workspace}“ eingeladen`;
  const text = `${input.inviter} hat dich ${role}zum Arbeitsbereich „${input.workspace}“ in ${instanceName()} eingeladen.\n\nMelde dich mit dieser E-Mail-Adresse an, dann ist der Arbeitsbereich sofort da:\n${url}\n`;
  const html = layout(
    `Einladung zu „${input.workspace}“`,
    [
      `${escape(input.inviter)} hat dich ${role}zum Arbeitsbereich <strong>${escape(input.workspace)}</strong> eingeladen.`,
      "Melde dich mit dieser E-Mail-Adresse an, dann ist der Arbeitsbereich sofort da.",
    ],
    { label: "Flowplan öffnen", url },
  );
  return queueMail(input.email, subject, text, html);
}

// Unread notifications older than a few minutes (not seen in the app
// meanwhile) are bundled into one e-mail per person.
const DIGEST_DELAY_MS = 10 * 60_000;
export function queueNotificationDigests(now = Date.now()) {
  if (!mailConfig()) return 0;
  const cutoff = new Date(now - DIGEST_DELAY_MS).toISOString().replace("T", " ").slice(0, 19);
  const pending = all<{
    id: string;
    user_id: string;
    body: string;
    page_id: string | null;
    row_id: string | null;
    thread_id: string | null;
    kind: string | null;
    email: string;
    name: string;
  }>(
    `SELECT n.id,n.user_id,n.body,n.page_id,n.row_id,n.thread_id,n.kind,u.email,u.name FROM notifications n
     JOIN users u ON u.id=n.user_id
     WHERE n.read_at IS NULL AND n.emailed_at IS NULL AND n.created_at<=? AND u.disabled=0 AND u.demo_until IS NULL
       AND u.email LIKE '%@%'
       AND NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id=n.user_id AND p.kind=COALESCE(n.kind,'comment') AND p.email=0)
     ORDER BY n.created_at LIMIT 2000`,
    cutoff,
  );
  const byUser = new Map<string, typeof pending>();
  for (const n of pending) byUser.set(n.user_id, [...(byUser.get(n.user_id) || []), n]);
  const url = appUrl();
  let queued = 0;
  transaction(() => {
    for (const items of byUser.values()) {
      const first = items[0];
      const link = (n: (typeof items)[number]) =>
        n.page_id
          ? `${url}/#page=${n.page_id}${n.row_id ? `&row=${n.row_id}` : ""}${n.thread_id ? `&thread=${n.thread_id}` : ""}`
          : `${url}/#inbox`;
      const shown = items.slice(0, 20);
      const more = items.length - shown.length;
      const subject =
        items.length === 1 ? first.body : `${items.length} neue Benachrichtigungen in ${instanceName()}`;
      const text = `Hallo ${first.name},\n\n${shown.map((n) => `• ${n.body}\n  ${link(n)}`).join("\n")}${more > 0 ? `\n… und ${more} weitere` : ""}\n\nPosteingang: ${url}/#inbox\n`;
      const html = layout(
        items.length === 1 ? "Neue Benachrichtigung" : `${items.length} neue Benachrichtigungen`,
        [
          `Hallo ${escape(first.name)}, das ist in Flowplan passiert:`,
          `<ul style="padding-left:18px;margin:0">${shown
            .map((n) => `<li style="margin:0 0 8px"><a href="${escape(link(n))}" style="color:#3b3fd8">${escape(n.body)}</a></li>`)
            .join("")}${more > 0 ? `<li>… und ${more} weitere</li>` : ""}</ul>`,
        ],
        { label: "Posteingang öffnen", url: `${url}/#inbox` },
      );
      if (queueMail(first.email, subject, text, html)) queued++;
      for (const n of items)
        run("UPDATE notifications SET emailed_at=CURRENT_TIMESTAMP WHERE id=?", n.id);
    }
  });
  return queued;
}

// Sends what is due; failed messages are retried with a growing pause and
// given up after 8 attempts.
export async function flushMailQueue(now = Date.now()) {
  const config = mailConfig();
  if (!config) return;
  const due = all<{ id: string; recipient: string; subject: string; text: string; html: string; attempts: number }>(
    "SELECT id,recipient,subject,text,html,attempts FROM mail_queue WHERE sent_at IS NULL AND attempts<8 AND next_at<=? ORDER BY next_at LIMIT 50",
    now,
  );
  for (const mail of due) {
    // Claim it first: another run (worker, immediate dispatch) must not
    // send the same message at the same time.
    if (!run("UPDATE mail_queue SET next_at=? WHERE id=? AND sent_at IS NULL AND next_at<=?", Date.now() + 10 * 60_000, mail.id, now).changes)
      continue;
    try {
      await send(config, { to: mail.recipient, subject: mail.subject, text: mail.text, html: mail.html });
      run("UPDATE mail_queue SET sent_at=?,error=NULL WHERE id=?", Date.now(), mail.id);
    } catch (error) {
      const attempts = mail.attempts + 1;
      run(
        "UPDATE mail_queue SET attempts=?,next_at=?,error=? WHERE id=?",
        attempts,
        Date.now() + Math.min(6 * 3600_000, 60_000 * 2 ** attempts),
        String((error as Error).message || error).slice(0, 500),
        mail.id,
      );
    }
  }
  // Sent mail is kept a week for the overview, then removed.
  run("DELETE FROM mail_queue WHERE sent_at IS NOT NULL AND sent_at<?", now - 7 * 86400_000);
}

export function dispatchMail() {
  runtime.flowplanMailRun ??= flushMailQueue()
    .catch((error) => console.error("E-Mail-Versand fehlgeschlagen", error))
    .finally(() => {
      runtime.flowplanMailRun = undefined;
    });
  return runtime.flowplanMailRun;
}

export function startMailWorker() {
  if (runtime.flowplanMailTimer || !mailConfig()) return;
  runtime.flowplanMailTimer = setInterval(() => {
    try {
      queueNotificationDigests();
    } catch (error) {
      console.error("E-Mail-Zusammenfassung fehlgeschlagen", error);
    }
    void dispatchMail();
  }, 60_000);
  runtime.flowplanMailTimer.unref?.();
}

// For the administration: configuration (without secrets) and queue state.
export function mailStatus() {
  const config = mailConfig();
  const count = (sql: string) => Number(one<{ n: number }>(sql)?.n || 0);
  return {
    configured: !!config,
    host: config ? `${config.host}:${config.port}${config.secure ? " (TLS)" : ""}` : null,
    from: config?.from || null,
    pending: count("SELECT COUNT(*) n FROM mail_queue WHERE sent_at IS NULL AND attempts<8"),
    failed: count("SELECT COUNT(*) n FROM mail_queue WHERE sent_at IS NULL AND attempts>=8"),
    sentWeek: count("SELECT COUNT(*) n FROM mail_queue WHERE sent_at IS NOT NULL"),
    lastError:
      one<{ error: string }>(
        "SELECT error FROM mail_queue WHERE error IS NOT NULL ORDER BY next_at DESC LIMIT 1",
      )?.error || null,
  };
}

// Admin test: sent right away (not queued) so the answer shows the result.
export async function sendTestMail(to: string) {
  const config = mailConfig();
  if (!config) throw new HttpError(400, "Kein SMTP-Server eingerichtet (SMTP_HOST).");
  try {
    await send(config, {
      to,
      subject: `Test-E-Mail von ${instanceName()}`,
      text: `Der E-Mail-Versand von ${appUrl()} funktioniert.`,
      html: layout("E-Mail-Versand funktioniert", [`Diese Test-E-Mail wurde von ${escape(appUrl())} gesendet.`]),
    });
  } catch (error) {
    throw new HttpError(502, `Senden fehlgeschlagen: ${(error as Error).message}`);
  }
}
