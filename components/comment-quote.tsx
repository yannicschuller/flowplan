"use client";
import { Fragment } from "react";
import { useT } from "./i18n";

// The quoted passage of a text comment (lib/comment-positions.ts
// commentQuote): line breaks stay line breaks (white-space in the CSS),
// embedded media, formulas, mentions … (U+FFFC) show as a placeholder.
// Quotes stored before hard breaks became line breaks show one there too.
export function CommentQuote({ quote }: { quote: string }) {
  const t = useT();
  return (
    <>
      {quote.split("￼").map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="comment-quote-object">
              {t("Medienblock", "media block")}
            </span>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}
