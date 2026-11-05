// A formatted text value (#126) as React elements – never as HTML: the
// inline Markdown of lib/inline-markdown.ts becomes <strong>, <em>, <s>,
// <code>, <br> and links to http, https or mailto that open in a new tab.
// Inside a button (board and gallery cards) links stay text (`links`
// false): a link there would be a control inside a control.
import { Fragment, type ReactNode } from "react";
import { hasInlineMarkup, parseInline } from "@/lib/inline-markdown";

function lines(text: string, key: string, oneLine: boolean): ReactNode {
  if (!text.includes("\n")) return text;
  // One line (table cells, cards): a line break shows as a space.
  if (oneLine) return text.replace(/\n+/g, " ");
  const parts = text.split("\n");
  return parts.map((part, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {part}
    </Fragment>
  ));
}

export function InlineText({ value, links = true, oneLine = false, className }: { value: unknown; links?: boolean; oneLine?: boolean; className?: string }) {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  if (!hasInlineMarkup(text)) return className ? <span className={className}>{lines(text, "t", oneLine)}</span> : <>{lines(text, "t", oneLine)}</>;
  const runs = parseInline(text);
  const out: ReactNode[] = [];
  // Neighbouring runs of the same link become one <a>.
  for (let i = 0; i < runs.length; ) {
    const href = runs[i].href;
    let j = i + 1;
    while (href && j < runs.length && runs[j].href === href) j++;
    const group = runs.slice(i, j).map((run, k) => {
      let node: ReactNode = lines(run.text, `${i}-${k}`, oneLine);
      if (run.code) node = <code>{node}</code>;
      if (run.strike) node = <s>{node}</s>;
      if (run.italic) node = <em>{node}</em>;
      if (run.bold) node = <strong>{node}</strong>;
      return <Fragment key={k}>{node}</Fragment>;
    });
    out.push(
      href && links ? (
        <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="inline-link" onClick={(e) => e.stopPropagation()}>
          {group}
        </a>
      ) : href ? (
        <span key={i} className="inline-link">
          {group}
        </span>
      ) : (
        <Fragment key={i}>{group}</Fragment>
      ),
    );
    i = j;
  }
  return <span className={["inline-text", className].filter(Boolean).join(" ")}>{out}</span>;
}
