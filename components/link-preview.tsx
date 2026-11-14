"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { api, PageIcon } from "./ui";
import { shownPageIcon } from "@/lib/page-link-icons";
import { linkTargetInfo } from "./page-link-icons";
import { parsePageLocation, pageLocationHash, inAppPageHash } from "@/lib/page-location";
import { openModeOf, requestOpen, type OpenMode } from "@/lib/open-place";
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
// Ctrl/⌘-click (or the middle button) on a page link: a new tab, with Shift
// the other frame (#279, lib/open-place.ts; components/frame-tabs.tsx
// answers). False when nobody took it (phones) – then as before.
export function openInTab(href: string, mode: OpenMode, origin: Element | null = null) {
  const hash = href.indexOf("#page=");
  return hash >= 0 && requestOpen(href.slice(hash), mode, origin);
}
// A plain click inside the right frame goes there, not to the main view.
const inSideFrame = (origin: Element | null) => !!origin?.closest?.(".split-pane");
export function openReference(href: string, event?: MouseEvent) {
  if (!href) return;
  const hash = href.indexOf("#page=");
  const origin = (event?.target as Element | null) ?? null;
  if (hash >= 0 && !(event?.metaKey || event?.ctrlKey)) {
    if (inSideFrame(origin) && requestOpen(href.slice(hash), "here", origin)) return;
    location.hash = href.slice(hash);
    return;
  }
  if (hash >= 0 && event && openInTab(href, openModeOf(event), origin)) return;
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
  // Block links (#88): the block's text in place of the page's beginning.
  const blocks = useRef(new Map<string, { text: string; found: boolean } | null>());
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
        const withBlock = async (preview: Preview): Promise<Preview> => {
          if (!location.blockId) return preview;
          const key = `${location.pageId}:${location.rowId || ""}:${location.blockId}`;
          let block = blocks.current.get(key);
          if (block === undefined) {
            block = await api<{ text: string; found: boolean; encrypted?: boolean }>(
              `/api/pages/${location.pageId}/blocks/${encodeURIComponent(location.blockId)}${location.rowId ? `?row=${location.rowId}` : ""}`,
            )
              .then((r) => (r.encrypted ? null : { text: r.text, found: r.found }))
              .catch(() => null);
            blocks.current.set(key, block);
          }
          if (!block) return preview;
          return { ...preview, excerpt: block.found ? block.text : t("Dieser Block existiert nicht mehr.", "This block no longer exists.") };
        };
        const cached = cache.current.get(location.pageId);
        if (cached && typeof cached !== "string") {
          const shown = await withBlock(cached);
          if (current.current === target) setCard({ kind: "page", rect, preview: shown });
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
          const shown = await withBlock(preview);
          if (current.current === target)
            setCard({ kind: "page", rect, preview: shown });
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
        target.matches('a[href*="#page="]') &&
        !target.closest('[contenteditable="true"]') &&
        openInTab(target.getAttribute("href") || "", openModeOf(event), target)
      ) {
        event.preventDefault();
        return;
      }
      if (!target.closest('[contenteditable="true"]')) {
        // Read-only text in the app (locked pages, reading mode, pages and
        // records one may only read): links to pages, blocks and records
        // open here like in editable text, with history (#274) – their
        // stored target="_blank" would open a new tab (a new window in the
        // desktop app). Modifier clicks stay with the browser; presentations
        // are not left by a click.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!target.matches('a[target="_blank"]') || target.closest(".presentation-document, .presenter-notes-text")) return;
        const hash = inAppPageHash(target.getAttribute("href") || "", location.href);
        if (!hash) return;
        event.preventDefault();
        if (inSideFrame(target) && requestOpen(hash, "here", target)) return;
        location.hash = hash;
        return;
      }
      const selection = window.getSelection();
      // Text selected in the link is no click on it. Ctrl/⌘-click makes the
      // editor select the clicked node: still a link click. A selection
      // elsewhere (a mention clicked before) stays when the click lands on
      // the link's icon, which the editor does not place the caret in.
      if (
        selection &&
        !selection.isCollapsed &&
        selection.containsNode(target, true) &&
        !(event.metaKey || event.ctrlKey)
      )
        return;
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
            {/* The page's own icon, as it is now (#96). */}
            <PageIcon
              name={shownPageIcon(linkTargetInfo({ pageId: card.preview.id })?.icon ?? card.preview.icon, card.preview.kind)}
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
