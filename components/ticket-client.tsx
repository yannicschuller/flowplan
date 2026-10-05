"use client";
import { useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import type { customerTicket } from "@/lib/service-desk";

type Ticket = ReturnType<typeof customerTicket>;

// The customer's view of their request: status, their answers and the
// conversation with the team, with a reply box.
export default function TicketClient({ token, initial }: { token: string; initial: Ticket }) {
  const t = useT();
  const [ticket, setTicket] = useState(initial),
    [body, setBody] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const date = (at: number) =>
    new Date(at).toLocaleString(t("de-DE", "en-GB"), { dateStyle: "medium", timeStyle: "short" });
  return (
    <main className="public-page ticket-page">
      <a href="/" className="public-brand">
        flowplan
      </a>
      <p className="ticket-kicker">{ticket.title}</p>
      <h1>{ticket.subject || t("Deine Anfrage", "Your request")}</h1>
      <p className="muted">
        {t("Eingegangen am", "Received on")} {date(ticket.created_at)}
      </p>
      {ticket.status.length > 0 && (
        <dl className="ticket-status" aria-label={t("Stand", "Status")}>
          {ticket.status.map((s) => (
            <div key={s.id}>
              <dt>{s.name}</dt>
              <dd>{s.value || "–"}</dd>
            </div>
          ))}
        </dl>
      )}
      <section className="ticket-section">
        <h2>{t("Unterhaltung", "Conversation")}</h2>
        {ticket.messages.length === 0 && (
          <p className="muted">{t("Noch keine Nachrichten. Das Team meldet sich hier.", "No messages yet. The team will answer here.")}</p>
        )}
        <ol className="ticket-messages">
          {ticket.messages.map((m) => (
            <li key={m.id} className={m.team ? "team" : "customer"}>
              <div className="ticket-meta">
                <strong>{m.team ? m.name || t("Team", "Team") : t("Du", "You")}</strong>
                <time dateTime={new Date(m.created_at).toISOString()}>{date(m.created_at)}</time>
              </div>
              <p>{m.body}</p>
            </li>
          ))}
        </ol>
        <form
          className="ticket-reply"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!body.trim()) return;
            setBusy(true);
            setError("");
            try {
              const response = await fetch(`/api/tickets/${token}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ body }),
              });
              const data = await response.json().catch(() => ({}));
              if (!response.ok) throw new Error(serverMessage(data.error) || t("Nachricht konnte nicht gesendet werden.", "The message could not be sent."));
              setTicket(data);
              setBody("");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Antwort an das Team", "Reply to the team")}
            <textarea value={body} maxLength={5000} rows={4} onChange={(e) => setBody(e.target.value)} disabled={busy} />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy || !body.trim()}>
            {busy ? t("Wird gesendet …", "Sending …") : t("Antwort senden", "Send reply")}
          </button>
        </form>
      </section>
      {ticket.answers.length > 0 && (
        <section className="ticket-section">
          <h2>{t("Deine Angaben", "What you sent")}</h2>
          <dl className="ticket-answers">
            {ticket.answers.map((a) => (
              <div key={a.id}>
                <dt>{a.name}</dt>
                <dd>{a.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <p className="muted ticket-note">
        {t(
          "Behalte diesen Link für dich – wer ihn hat, kann die Anfrage sehen und beantworten.",
          "Keep this link to yourself – anyone who has it can see and answer the request.",
        )}
      </p>
    </main>
  );
}
