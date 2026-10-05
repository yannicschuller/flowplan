"use client";
import { useCallback, useEffect, useState } from "react";
import { Copy, EnvelopeSimple } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";

type Thread = {
  ticket: { email: string | null; created_at: number; url: string | null } | null;
  messages: { id: string; author_name: string; body: string; created_at: number; team: boolean }[];
};

// The customer conversation of a record that came in through a form with
// the customer portal: shown only when there is one.
export default function TicketThread({
  pageId,
  rowId,
  editable,
  onError,
}: {
  pageId: string;
  rowId: string;
  editable: boolean;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [thread, setThread] = useState<Thread | null>(null),
    [body, setBody] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const load = useCallback(
    () =>
      api<Thread>(`/api/ticket-thread?page=${pageId}&row=${rowId}`)
        .then(setThread)
        .catch(() => setThread(null)),
    [pageId, rowId],
  );
  useEffect(() => {
    void load();
    // Customer replies show up while the record is open.
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);
  if (!thread?.ticket) return null;
  const date = (at: number) =>
    new Date(at).toLocaleString(t("de-DE", "en-GB"), { dateStyle: "medium", timeStyle: "short" });
  return (
    <section className="settings-section ticket-thread" aria-label={t("Kundenanfrage", "Customer request")}>
      <h3>{t("Kundenanfrage", "Customer request")}</h3>
      <p className="muted ticket-thread-meta">
        {thread.ticket.email ? (
          <>
            <EnvelopeSimple aria-hidden /> {thread.ticket.email}
          </>
        ) : (
          t("Ohne E-Mail-Adresse – die Antwort sieht die Person über ihren Link.", "No e-mail address – the person sees replies through their link.")
        )}
        {thread.ticket.url && (
          <button
            type="button"
            className="text-button"
            onClick={async () => {
              await navigator.clipboard.writeText(thread.ticket!.url!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            <Copy aria-hidden /> {copied ? t("Link kopiert", "Link copied") : t("Kundenlink kopieren", "Copy customer link")}
          </button>
        )}
      </p>
      <ol className="ticket-messages">
        {thread.messages.map((m) => (
          <li key={m.id} className={m.team ? "team" : "customer"}>
            <div className="ticket-meta">
              <strong>{m.team ? m.author_name : t("Kunde", "Customer")}</strong>
              <time dateTime={new Date(m.created_at).toISOString()}>{date(m.created_at)}</time>
            </div>
            <p>{m.body}</p>
          </li>
        ))}
      </ol>
      {thread.messages.length === 0 && (
        <p className="muted">{t("Noch keine Nachrichten.", "No messages yet.")}</p>
      )}
      {editable && (
        <form
          className="ticket-reply"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!body.trim()) return;
            setBusy(true);
            try {
              setThread(await api<Thread>("/api/command", { action: "ticket.reply", pageId, rowId, body }));
              setBody("");
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea
            aria-label={t("Antwort an den Kunden", "Reply to the customer")}
            placeholder={
              thread.ticket.email
                ? t("Antwort an den Kunden – geht per E-Mail raus", "Reply to the customer – sent by e-mail")
                : t("Antwort an den Kunden", "Reply to the customer")
            }
            value={body}
            maxLength={5000}
            rows={3}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />
          <button className="button primary" disabled={busy || !body.trim()}>
            {busy ? t("Wird gesendet …", "Sending …") : t("Antworten", "Reply")}
          </button>
        </form>
      )}
    </section>
  );
}
