"use client";
// Pages that name this page without linking to it; "Verlinken" turns the
// first mention there into a link.
import { useT } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { CaretDown, CaretRight, LinkSimple } from "@phosphor-icons/react";
import { api, PageIcon } from "./ui";

type Mention = { id: string; title: string; icon: string; snippet: string };

export function UnlinkedMentions({
  pageId,
  editable,
  onOpen,
  onLinked,
  onError,
}: {
  pageId: string;
  editable: boolean;
  onOpen: (id: string) => void;
  onLinked: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try {
      setMentions((await api<{ mentions: Mention[] }>(`/api/pages/${pageId}/unlinked`)).mentions);
    } catch {
      setMentions([]);
    }
  }, [pageId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!mentions.length) return null;
  return (
    <section className="unlinked-mentions">
      <button type="button" className="unlinked-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
        {t("Nicht verlinkte Erwähnungen", "Unlinked mentions")}{" "}<small>{mentions.length}</small>
      </button>
      {open && (
        <ul>
          {mentions.map((mention) => (
            <li key={mention.id}>
              <button type="button" className="unlinked-page" onClick={() => onOpen(mention.id)}>
                <PageIcon name={mention.icon} size={15} />
                {mention.title}
              </button>
              <span className="unlinked-snippet">{mention.snippet}</span>
              {editable && (
                <button
                  type="button"
                  className="button compact"
                  disabled={busy === mention.id}
                  onClick={async () => {
                    setBusy(mention.id);
                    try {
                      await api("/api/command", { action: "mention.link", pageId: mention.id, targetId: pageId });
                      await load();
                      onLinked();
                    } catch (e) {
                      onError((e as Error).message);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  <LinkSimple size={14} /> {t("Verlinken", "Link")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
