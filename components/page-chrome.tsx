"use client";
// What frames a page's view, the same in the main frame
// (components/workspace-app.tsx) and in the split view's right frame
// (components/split-pane.tsx, #652): the article's classes, the cover, the
// head with icon and title, the tags and properties, the panels below the
// page ("Verwandte Seiten", unlinked mentions, "Verlinkt von") and its
// sub-pages. What only the main frame has (the page menu in the top bar,
// the breadcrumbs, the icon and cover pickers) stays there and comes in
// through the callbacks.
import { ArrowUpRight, Lock, Plus } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { CoverFrame } from "./cover-frame";
import { useT } from "./i18n";
import { OfflineMark } from "./offline-mark";
import { PageReview } from "./page-review";
import { PagePropertyBar } from "./page-properties";
import { PageTitleField } from "./page-title-field";
import { RelatedPages } from "./related-pages";
import { PageIcon } from "./ui";
import { UnlinkedMentions } from "./unlinked-mentions";
import { useDiscoveryPanelsShown } from "@/lib/discovery-panels-prefs";
import { iconPixels, imageFileId } from "@/lib/page-appearance";
import { usePageIconPref } from "@/lib/page-icon-pref-client";
import { shownPageIcon } from "@/lib/page-link-icons";
import type { PageMeta } from "@/lib/page-properties";
import type { Page } from "@/lib/types";

type Act = (b: Record<string, unknown>) => Promise<unknown>;
type Member = Parameters<typeof PagePropertyBar>[0]["members"][number];

// The classes of the page's <article class="page-content …">.
export function pageContentClass(
  page: Pick<Page, "kind" | "font">,
  { fullWidth, blockRoom, extra = "" }: { fullWidth: boolean; blockRoom: boolean; extra?: string },
) {
  return [
    "page-content",
    page.kind === "database" && "database-page",
    page.kind === "whiteboard" && "whiteboard-page",
    page.kind === "notebook" && "notebook-page",
    page.kind === "workflow" && "workflow-page-content",
    fullWidth && "full-width",
    extra,
    blockRoom && "with-block-room",
    `font-${page.font || "sans"}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function PageCover({ page, onChange }: { page: Page; onChange?: () => void }) {
  const t = useT();
  if (!page.cover) return null;
  return (
    <CoverFrame className="page-cover" cover={page.cover} image={!!imageFileId(page.cover)} alt={t("Seiten-Cover", "Page cover")} position={`50% ${page.cover_position ?? 50}%`}>
      {onChange && (
        <button className="button cover-change" onClick={onChange}>
          {t("Cover ändern", "Change cover")}
        </button>
      )}
    </CoverFrame>
  );
}

// "Seitensymbol" (#214, app/page-icon-inline.css): the large icon above the
// title, or small on the title's first line; the title; the notices.
export function PageHeader({
  page,
  readOnly,
  kindOff,
  onIcon,
  onAddCover,
  onTitle,
  title,
}: {
  page: Page;
  readOnly: boolean;
  // Switched off for the instance (#386): read-only with a notice.
  kindOff: boolean;
  // Opens the icon picker; without it the icon only shows.
  onIcon?: () => void;
  // "Cover hinzufügen", for a page without a cover.
  onAddCover?: () => void;
  onTitle: (title: string) => void;
  // Instead of the title field (an encrypted title, components/e2ee.tsx).
  title?: ReactNode;
}) {
  const t = useT();
  const iconPlace = usePageIconPref();
  return (
    <div className={`document-header${iconPlace === "inline" ? " icon-inline" : ""}`}>
      <button className="large-page-icon" title={t("Seiten-Icon ändern", "Change page icon")} onClick={() => onIcon?.()}>
        <PageIcon name={shownPageIcon(page.icon, page.kind)} size={iconPixels[page.icon_size || ""]} />
      </button>
      {onAddCover && !page.cover && (
        <button className="add-cover text-button" onClick={onAddCover}>
          {t("Cover hinzufügen", "Add cover")}
        </button>
      )}
      {title ?? (
        <PageTitleField
          key={`${page.id}-title`}
          className="page-title"
          aria-label={t("Seitentitel", "Page title")}
          defaultValue={page.title}
          readOnly={readOnly}
          onBlur={(e) => {
            if (e.target.value.trim() && e.target.value !== page.title) onTitle(e.target.value);
          }}
        />
      )}
      {page.locked === 1 && (
        <div className="locked-notice">
          <Lock size={14} />
          {t("Diese Seite ist gesperrt.", "This page is locked.")}
        </div>
      )}
      {kindOff && (
        <div className="locked-notice" role="note">
          <Lock size={14} />
          {t("Auf dieser Instanz ausgeschaltet – die Seite bleibt erhalten und lässt sich nur lesen.", "Switched off on this instance – the page is kept and can only be read.")}
        </div>
      )}
    </div>
  );
}

// The review reminder and the tags and properties (#70).
export function PageMetaBar(props: {
  page: Page;
  members: Member[];
  editable: boolean;
  act: Act;
  taxonomy: Parameters<typeof PagePropertyBar>[0]["taxonomy"];
  meta: PageMeta | undefined;
  collapsedChoice?: boolean | null;
  spaces?: { id: string; name: string }[];
}) {
  const { page, members, editable, act } = props;
  return (
    <>
      <PageReview page={page} members={members} editable={editable} act={act} />
      <PagePropertyBar page={page} taxonomy={props.taxonomy} meta={props.meta} collapsedChoice={props.collapsedChoice} members={members} editable={editable} act={act} spaces={props.spaces} />
    </>
  );
}

export type Backlink = { id: string; title: string; icon: string; kind?: string; rowId?: string; pageTitle?: string };

// Below the page: related pages, unlinked mentions and the pages linking
// here – unless the person hid these panels.
export function PageDiscovery({
  page,
  closed,
  editable,
  backlinks,
  onOpenRelated,
  onOpenMention,
  onOpenBacklink,
  onLinked,
  onError,
}: {
  page: Page;
  // Locked or encrypted: nothing to relate or mention.
  closed: boolean;
  editable: boolean;
  backlinks: Backlink[] | undefined;
  onOpenRelated?: (pageId: string, rowId?: string) => void;
  onOpenMention: (pageId: string, rowId?: string) => void;
  onOpenBacklink: (link: Backlink) => void;
  onLinked: () => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const shown = useDiscoveryPanelsShown();
  if (!shown) return null;
  return (
    <div className="backlinks">
      {!closed && <RelatedPages key={`related-${page.id}`} pageId={page.id} onOpen={onOpenRelated} />}
      {!closed && <UnlinkedMentions key={page.id} pageId={page.id} editable={editable} onOpen={onOpenMention} onLinked={onLinked} onError={onError} />}
      {!!backlinks?.length && (
        <>
          <h3>{t("Verlinkt von", "Linked from")}</h3>
          {backlinks.map((p) => (
            <button key={`${p.id}-${p.rowId || ""}`} onClick={() => onOpenBacklink(p)}>
              <PageIcon name={shownPageIcon(p.icon, p.kind || (p.rowId ? "record" : "document"))} />
              {p.title}
              {p.pageTitle && <small className="muted">{p.pageTitle}</small>}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

// The page's sub-pages and "Unterseite hinzufügen".
export function SubPages({
  page,
  pages,
  recordParents,
  onOpen,
  onAdd,
}: {
  page: Page;
  pages: Page[];
  recordParents: { pageId: string; rowId: string }[] | undefined;
  onOpen: (id: string) => void;
  // Shown while the page is editable.
  onAdd?: () => void;
}) {
  const t = useT();
  return (
    <div className="subpages">
      {pages
        // Journal days are listed by the journal itself.
        // Pages below a record show with the record (#231).
        .filter(
          (p) =>
            p.parent_id === page.id && !p.journal_date && !(p.parent_row_id && recordParents?.some((r) => r.pageId === page.id && r.rowId === p.parent_row_id)),
        )
        .map((p) => (
          <button key={p.id} onClick={() => onOpen(p.id)}>
            <PageIcon name={p.icon} />
            {p.title}
            {p.offline && <OfflineMark state={p.offline} />}
            <ArrowUpRight />
          </button>
        ))}
      {onAdd && (
        <button className="text-button" onClick={onAdd}>
          <Plus size={16} />
          {t("Unterseite hinzufügen", "Add sub-page")}
        </button>
      )}
    </div>
  );
}
