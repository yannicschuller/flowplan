"use client";
// The path of the open page in the top bar (#231): ancestor pages, the
// database and an open record (lib/page-path.ts), each a real link (a new
// tab with ⌘/Ctrl or the middle button). A long path folds its middle
// into "…" with a menu of the hidden segments; phones show "…" and the
// current segment.
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { useT } from "./i18n";
import { PageIcon } from "./ui";
import { safeCollisionPadding } from "./safe-area";
import { shownPageIcon } from "@/lib/page-link-icons";
import { collapsePath, isMore, type PathSegment } from "@/lib/page-path";

export function PageBreadcrumb({ segments, room }: { segments: PathSegment[]; room: number }) {
  const t = useT();
  const { shown } = collapsePath(segments, room);
  const icon = (s: PathSegment, size = 16) => <PageIcon name={shownPageIcon(s.icon, s.kind === "record" ? "document" : s.kind)} size={size} />;
  return (
    <nav className="breadcrumb-path" aria-label={t("Pfad", "Path")}>
      <ol>
        {shown.map((item, i) => (
          <li key={isMore(item) ? "more" : item.key} className={isMore(item) ? "breadcrumb-more" : item.current ? "breadcrumb-current" : undefined}>
            {i > 0 && (
              <span className="breadcrumb-sep" aria-hidden="true">
                /
              </span>
            )}
            {isMore(item) ? (
              <Dropdown.Root>
                <Dropdown.Trigger
                  className="breadcrumb-more-button"
                  aria-label={t(`${item.more.length} weitere Ebenen`, `${item.more.length} more levels`)}
                  title={item.more.map((s) => s.title || t("Ohne Titel", "Untitled")).join(" / ")}
                >
                  …
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content className="dropdown breadcrumb-menu" align="start" collisionPadding={safeCollisionPadding()}>
                    {item.more.map((s) => (
                      <Dropdown.Item key={s.key} className="dropdown-item" asChild>
                        <a href={s.hash}>
                          {icon(s)}
                          <span>{s.title || t("Ohne Titel", "Untitled")}</span>
                        </a>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            ) : (
              <a className="breadcrumb-link" href={item.hash} aria-current={item.current ? "page" : undefined}>
                {icon(item)}
                <span>{item.title || t("Ohne Titel", "Untitled")}</span>
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
