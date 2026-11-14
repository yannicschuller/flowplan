import { HIDE_EXTERNAL_LINK_ICON_CLASS } from "./external-link-icon-pref";

// The classes on a published page's root (components/public-page.tsx):
// full width, the publication's own accent, and – when the publication says
// so (#217, publications.external_link_icon) – no arrow after links to the
// web (app/globals.css). A class, never a style attribute (strict CSP).
export function publicPageClass({ wide, themed, externalLinkIcon }: { wide: boolean; themed: boolean; externalLinkIcon: boolean }) {
  return ["public-page", wide && "public-wide", themed && "public-themed", !externalLinkIcon && HIDE_EXTERNAL_LINK_ICON_CLASS]
    .filter(Boolean)
    .join(" ");
}
