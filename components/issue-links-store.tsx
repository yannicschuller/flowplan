"use client";
// Links to issues, pull requests and merge requests in documents (#654):
// their status, asked for in batches (POST /api/issue-sync/preview,
// lib/issue-preview.ts) and kept here for the tab.
//   - The app turns the store on (LinkPreview, enableIssueLinks): only then
//     is anything asked – published pages never ask.
//   - Only links that come into view are asked for (IntersectionObserver),
//     and those the pointer rests on (the hover card).
//   - The state icon at a link is drawn by the editor (IssueLinkStates in
//     components/issue-links.tsx) and by read-only documents
//     (decorateIssueStates) from what the store knows; it never asks.
import { useEffect, useRef } from "react";
import { issueLinkShape } from "@/lib/issue-link-url";
import type { IssuePreviewResult, IssueState } from "@/lib/issue-preview";
import { useLocale, useT } from "./i18n";
import { ago } from "./page-activity";

const REFETCH_AFTER = 5 * 60_000;
const BATCH = 20;
// Where issue links count: documents and record documents (editor and
// read-only), not comments, the sidebar or cards.
export const ISSUE_LINK_SCOPE = ".document-editor";
const NOT_TEXT = ".whiteboard-embed, .link-card, .linked-database, .synced-block, [data-plugin], .page-link-icon, .issue-state-icon";

const known = new Map<string, { result: IssuePreviewResult; at: number }>();
const queued = new Set<string>();
const asking = new Map<string, Promise<IssuePreviewResult | null>>();
const waiting = new Map<string, ((result: IssuePreviewResult | null) => void)[]>();
let enabled = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  version++;
  listeners.forEach((listener) => listener());
};
export const issueLinksVersion = () => version;
export function subscribeIssueLinks(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// Whether a link in the page is one to ask about.
export function isIssueLink(a: Element | null | undefined): a is HTMLAnchorElement {
  return !!a && a.matches("a[href]") && issueLinkShape(a.getAttribute("href")) && !!a.closest(ISSUE_LINK_SCOPE) && !a.closest(NOT_TEXT);
}

async function load() {
  timer = null;
  const urls = [...queued].slice(0, BATCH);
  urls.forEach((url) => queued.delete(url));
  if (!urls.length) return;
  let previews: Record<string, IssuePreviewResult> = {};
  try {
    const response = await fetch("/api/issue-sync/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
      cache: "no-store",
    });
    if (response.ok) previews = ((await response.json()) as { previews?: Record<string, IssuePreviewResult> }).previews || {};
  } catch {
    // Offline: unknown for now, asked again later.
  }
  const now = Date.now();
  for (const url of urls) {
    const result = previews[url] || null;
    if (result) known.set(url, { result, at: now });
    for (const done of waiting.get(url) || []) done(result);
    waiting.delete(url);
    asking.delete(url);
  }
  if (queued.size) timer = setTimeout(load, 50);
  notify();
}
function ask(url: string): Promise<IssuePreviewResult | null> {
  const running = asking.get(url);
  if (running) return running;
  const job = new Promise<IssuePreviewResult | null>((resolve) => waiting.set(url, [...(waiting.get(url) || []), resolve]));
  asking.set(url, job);
  queued.add(url);
  timer ??= setTimeout(load, 40);
  return job;
}

// What is known about a link (undefined: not yet), without asking.
export function issuePreviewOf(href: string | null | undefined): IssuePreviewResult | undefined {
  return href ? known.get(href)?.result : undefined;
}
// The link's state once known – the icon at the link.
export function issueStateOf(href: string | null | undefined): IssueState | null {
  const result = issuePreviewOf(href);
  return result && "state" in result ? result.state : null;
}
// The preview for the hover card: known (and fresh) or asked for now.
export async function loadIssuePreview(href: string): Promise<IssuePreviewResult | null> {
  if (!enabled) return null;
  const kept = known.get(href);
  if (kept && Date.now() - kept.at < REFETCH_AFTER) return kept.result;
  return await ask(href);
}

// The app: watches the issue links that come into view and asks for them.
export function enableIssueLinks(): () => void {
  if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return () => {};
  enabled++;
  const watched = new WeakSet<Element>();
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const href = (entry.target as HTMLAnchorElement).getAttribute("href") || "";
      seen.unobserve(entry.target);
      watched.delete(entry.target);
      const kept = known.get(href);
      if (!kept || Date.now() - kept.at > REFETCH_AFTER) void ask(href);
    }
  });
  let scan: ReturnType<typeof setTimeout> | null = null;
  const look = () => {
    scan = null;
    for (const a of document.querySelectorAll<HTMLAnchorElement>(`${ISSUE_LINK_SCOPE} a[href^="https://"]`)) {
      if (watched.has(a) || !isIssueLink(a)) continue;
      const kept = known.get(a.getAttribute("href") || "");
      if (kept && Date.now() - kept.at < REFETCH_AFTER) continue;
      watched.add(a);
      seen.observe(a);
    }
  };
  const changes = new MutationObserver(() => {
    scan ??= setTimeout(look, 250);
  });
  changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  look();
  return () => {
    enabled--;
    changes.disconnect();
    seen.disconnect();
    if (scan) clearTimeout(scan);
  };
}

/* ---------- The state icon ---------- */

export function issueStateLabel(state: IssueState, t: (de: string, en: string) => string) {
  return state === "open"
    ? t("Offen", "Open||status")
    : state === "closed"
      ? t("Geschlossen", "Closed")
      : state === "merged"
        ? t("Zusammengeführt", "Merged")
        : t("Entwurf", "Draft");
}
// A small span (editor widgets, read-only HTML); its shape and colour come
// from app/issue-links.css by data-state and data-kind.
export function issueStateElement(state: IssueState, kind: string, label: string, doc: Document = document): HTMLElement {
  const span = doc.createElement("span");
  span.className = "issue-state-icon";
  span.contentEditable = "false";
  span.dataset.state = state;
  span.dataset.kind = kind;
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", label);
  span.title = label;
  return span;
}
// Read-only documents (reading mode, records one may only read): the icon
// in front of each issue link the store knows, kept up to date; returns the
// cleanup.
export function decorateIssueStates(root: HTMLElement, label: (state: IssueState) => string): () => void {
  const draw = () => {
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')) {
      if (!issueLinkShape(a.getAttribute("href")) || a.closest(NOT_TEXT)) continue;
      const result = issuePreviewOf(a.getAttribute("href"));
      const state = result && "state" in result ? result.state : null;
      const current = a.querySelector<HTMLElement>(":scope > .issue-state-icon");
      if ((current?.dataset.state || null) === state) continue;
      current?.remove();
      if (state && result && "kind" in result) a.prepend(issueStateElement(state, result.kind, label(state), root.ownerDocument));
    }
  };
  draw();
  const unsubscribe = subscribeIssueLinks(draw);
  return () => {
    unsubscribe();
    for (const icon of root.querySelectorAll("a > .issue-state-icon")) icon.remove();
  };
}

/* ---------- The hover card ---------- */

// Colours from the provider, as custom properties (no style attributes).
function LabelChip({ name, color }: { name: string; color: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (color) element.style.setProperty("--issue-label", color);
    else element.style.removeProperty("--issue-label");
  }, [color]);
  return (
    <span ref={ref} className={`issue-label${color ? " issue-label-colored" : ""}`}>
      {name}
    </span>
  );
}
const initials = (name: string) => name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";
function AuthorMark({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let hue = 0;
    for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    ref.current?.style.setProperty("--issue-author-hue", String(hue));
  }, [name]);
  return (
    <span ref={ref} className="issue-author-mark" aria-hidden>
      {initials(name)}
    </span>
  );
}
const providerName = { github: "GitHub", gitlab: "GitLab", forgejo: "Forgejo" } as const;

// The card's contents (components/link-preview.tsx draws the card).
export function IssueCardBody({ result }: { result: IssuePreviewResult | null }) {
  const t = useT();
  const locale = useLocale();
  if (!result) return <small>{t("Vorschau wird geladen …", "Loading preview …")}</small>;
  if ("error" in result)
    return (
      <small className="issue-preview-error">
        {result.error === "private"
          ? t("Privates Repository – nicht verfügbar", "Private repository – not available")
          : result.error === "not_found"
            ? t("Nicht gefunden oder kein Zugriff", "Not found or no access")
            : result.error === "rate_limited"
              ? t("Der Anbieter begrenzt gerade die Anfragen – bitte später noch einmal.", "The provider is limiting requests right now – please try again later.")
              : t("Nicht verfügbar", "Not available")}
      </small>
    );
  const created = Date.parse(result.createdAt);
  const label = issueStateLabel(result.state, t);
  return (
    <>
      <strong className="issue-preview-title">
        <span className="issue-state-icon" data-state={result.state} data-kind={result.kind} aria-hidden />
        <span>{result.title || t("Ohne Titel", "Untitled")}</span>
      </strong>
      <small className="issue-preview-meta">
        <span className="issue-state-badge" data-state={result.state}>
          {label}
        </span>
        <span>
          {result.repo} #{result.number}
        </span>
        <span className="issue-preview-provider">{providerName[result.provider]}</span>
      </small>
      {result.author && (
        <small className="issue-preview-author">
          <AuthorMark name={result.author} />
          <span>
            {Number.isFinite(created)
              ? t(`${result.author} hat es ${ago(created, Date.now(), locale)} erstellt`, `${result.author} created ${ago(created, Date.now(), locale)}`)
              : result.author}
          </span>
        </small>
      )}
      {result.excerpt && <p>{result.excerpt}</p>}
      {result.labels.length > 0 && (
        <span className="issue-preview-labels">
          {result.labels.map((l) => (
            <LabelChip key={l.name} name={l.name} color={l.color} />
          ))}
        </span>
      )}
    </>
  );
}
