"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { api, PageIcon } from "./ui";
import { parsePageLocation, pageLocationHash } from "@/lib/page-location";
import type { ContactCardData } from "@/lib/contacts-io";
import { ContactAvatar } from "./contacts";

type Preview = {
  id: string;
  title: string;
  icon: string;
  kind: "document" | "database";
  space: string;
  excerpt: string;
  rows: number;
  updatedAt: string;
};
type Card =
  | { kind: "page"; rect: DOMRect; preview: Preview | null; error?: string }
  // A link to a record of a contacts database (issue #64).
  | { kind: "contact"; rect: DOMRect; contact: ContactCardData }
  | { kind: "person"; rect: DOMRect; name: string; email: string };

// Spoiler text in read-only content opens (and closes) with a click; while
// writing it stays readable.
export function revealSpoiler(event: MouseEvent | React.MouseEvent) {
  const spoiler = (event.target as Element | null)?.closest?.("[data-spoiler]");
  // Inside editors the editor's own plugin opens spoilers.
  if (!spoiler || spoiler.closest(".ProseMirror")) return false;
  event.preventDefault();
  spoiler.toggleAttribute("data-revealed");
  return true;
}
// Ctrl/⌘-click on a page link: the split view next to the open page, when
// the window is wide enough (components/workspace-app.tsx answers the
// event). False when nobody took it – then a new tab as before.
export function openInSplit(href: string) {
  const hash = href.indexOf("#page=");
  const target = hash >= 0 ? parsePageLocation(href.slice(hash)) : null;
  if (!target || target.rowId) return false;
  return !window.dispatchEvent(new CustomEvent("flowplan:open-split", { detail: target.pageId, cancelable: true }));
}
export function openReference(href: string, event?: MouseEvent) {
  if (!href) return;
  const hash = href.indexOf("#page=");
  if (hash >= 0 && !(event?.metaKey || event?.ctrlKey)) {
    location.hash = href.slice(hash);
    return;
  }
  if (hash >= 0 && !event?.shiftKey && openInSplit(href)) return;
  if (href.startsWith("/") && !href.startsWith("//") && !event?.metaKey) {
    location.assign(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
// Hover cards for page links and person mentions in documents, comments and
// database cells. Previews are fetched once per page and respect permissions.
export function LinkPreview({
  members,
}: {
  members: { id: string; name: string; email: string }[];
}) {
  const t = useT();
  const [card, setCard] = useState<Card | null>(null);
  const cache = useRef(new Map<string, Preview | string>());
  // Records: their contact card, or null for records of other databases.
  const contacts = useRef(new Map<string, ContactCardData | null>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<Element | null>(null);
  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      current.current = null;
      setCard(null);
    };
    const show = (target: Element) => {
      if (current.current === target) return;
      if (timer.current) clearTimeout(timer.current);
      current.current = target;
      timer.current = setTimeout(async () => {
        // The link may be gone meanwhile (the page changed under it).
        if (!target.isConnected) return clear();
        const rect = target.getBoundingClientRect();
        const person = target.getAttribute("data-mention");
        if (person) {
          const member = members.find((m) => m.id === person);
          if (member)
            setCard({
              kind: "person",
              rect,
              name: member.name,
              email: member.email,
            });
          return;
        }
        const href = target.getAttribute("href") || "";
        const location = parsePageLocation(href.slice(href.indexOf("#")));
        if (!location) return;
        if (location.rowId) {
          const key = `${location.pageId}:${location.rowId}`;
          let contact = contacts.current.get(key);
          if (contact === undefined) {
            contact = await api<{ card: ContactCardData | null }>(`/api/contacts?view=card&page=${location.pageId}&row=${location.rowId}`)
              .then((r) => r.card)
              .catch(() => null);
            contacts.current.set(key, contact);
          }
          if (contact) {
            if (current.current === target) setCard({ kind: "contact", rect, contact });
            return;
          }
        }
        const cached = cache.current.get(location.pageId);
        if (cached && typeof cached !== "string") {
          setCard({ kind: "page", rect, preview: cached });
          return;
        }
        setCard({ kind: "page", rect, preview: null });
        try {
          const preview =
            cached === undefined
              ? await api<Preview>(`/api/pages/${location.pageId}/preview`)
              : null;
          if (!preview) throw new Error(String(cached));
          cache.current.set(location.pageId, preview);
          if (current.current === target)
            setCard({ kind: "page", rect, preview });
        } catch (e) {
          const message = (e as Error).message || t("Nicht verfügbar", "Not available");
          cache.current.set(location.pageId, message);
          if (current.current === target)
            setCard({ kind: "page", rect, preview: null, error: message });
        }
      }, 350);
    };
    const over = (event: Event) => {
      const target = (event.target as Element | null)?.closest?.(
        'a[href*="#page="], span[data-mention]',
      );
      if (!target || target.closest(".sidebar, .link-preview")) return;
      show(target);
    };
    const out = (event: Event) => {
      const related = (event as MouseEvent).relatedTarget as Element | null;
      if (current.current && related && current.current.contains(related))
        return;
      // A contact card can be entered (its links are clickable).
      if (related?.closest?.(".link-preview.contact-preview")) return;
      if (
        (event.target as Element | null)?.closest?.(
          'a[href*="#page="], span[data-mention]',
        )
      )
        clear();
    };
    // Links and mentions inside editable text do not react to clicks by
    // themselves: page links open the page, other links a new tab, people
    // show their card.
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      if (revealSpoiler(event)) return;
      const target = (event.target as Element | null)?.closest?.(
        "a[href], span[data-mention]",
      );
      if (!target || target.closest(".sidebar, .link-preview")) return;
      // Opening a page removes the link before the pointer can leave it, so
      // no mouseout would ever close the card.
      if (target.matches('a[href*="#page="]')) clear();
      if (target.matches("span[data-mention]")) {
        if (timer.current) clearTimeout(timer.current);
        current.current = null;
        show(target);
        return;
      }
      // Read-only text (reading mode, split view): Ctrl/⌘-click as well.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        target.matches('a[href*="#page="]') &&
        !target.closest('[contenteditable="true"]') &&
        openInSplit(target.getAttribute("href") || "")
      ) {
        event.preventDefault();
        return;
      }
      if (!target.closest('[contenteditable="true"]')) return;
      const selection = window.getSelection();
      // Ctrl/⌘-click makes the editor select the clicked node: still a link click.
      if (selection && !selection.isCollapsed && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      openReference(target.getAttribute("href") || "", event);
    };
    document.addEventListener("click", click, true);
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("focusout", out);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("hashchange", clear);
    return () => {
      window.removeEventListener("hashchange", clear);
      document.removeEventListener("click", click, true);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("focusout", out);
      window.removeEventListener("scroll", clear, true);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [members]);
  if (!card) return null;
  const top = Math.min(card.rect.bottom + 6, window.innerHeight - (card.kind === "contact" ? 220 : 170)),
    left = Math.max(8, Math.min(card.rect.left, window.innerWidth - 328));
  if (card.kind === "contact") {
    const c = card.contact;
    const close = () => {
      current.current = null;
      setCard(null);
    };
    return (
      <div className="link-preview contact-preview" role="dialog" aria-label={c.name} style={{ top, left }} onMouseLeave={close}>
        <div className="contact-preview-head">
          <ContactAvatar name={c.name} photo={c.photo} size={40} />
          <span>
            <strong>{c.name || t("Ohne Titel", "Untitled")}</strong>
            {(c.position || c.company) && <small>{[c.position, c.company].filter(Boolean).join(" · ")}</small>}
          </span>
        </div>
        {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
        {(c.phone || c.mobile) && <a href={`tel:${(c.phone || c.mobile).replace(/[^\d+]/g, "")}`}>{c.phone || c.mobile}</a>}
        {c.missing && <small className="ldap-marker missing">{t("Nicht mehr im Verzeichnis", "No longer in directory")}</small>}
        <a
          className="contact-preview-open"
          href={`/${pageLocationHash({ pageId: c.pageId, rowId: c.rowId })}`}
          onClick={(event) => {
            event.preventDefault();
            close();
            location.hash = pageLocationHash({ pageId: c.pageId, rowId: c.rowId });
          }}
        >
          {t("Profil öffnen", "Open profile")} →
        </a>
      </div>
    );
  }
  return (
    <div className="link-preview" role="tooltip" style={{ top, left }}>
      {card.kind === "person" ? (
        <>
          <strong>{card.name}</strong>
          <small>{card.email}</small>
        </>
      ) : card.preview ? (
        <>
          <strong>
            <PageIcon
              name={
                card.preview.kind === "database" ? "table" : card.preview.icon
              }
              size={16}
            />
            {card.preview.title}
          </strong>
          <small>
            {card.preview.space}
            {card.preview.kind === "database"
              ? t(` · ${card.preview.rows} Einträge`, ` · ${card.preview.rows} records`)
              : ""}
          </small>
          {card.preview.excerpt && <p>{card.preview.excerpt}</p>}
        </>
      ) : (
        <small>{serverMessage(card.error) || t("Vorschau wird geladen …", "Loading preview …")}</small>
      )}
    </div>
  );
}
