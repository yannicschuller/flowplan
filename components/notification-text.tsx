"use client";
// A formatted notification message in the inbox (#330, lib/notify-text.ts):
// React elements, never HTML from the text. Links open in a new tab,
// mentions of current members are the app's person chips (the hover and
// click card of link-preview.tsx), others plain "@Name"; formulas show
// their LaTeX until KaTeX is loaded (lib/math-render-lazy.ts) and are set
// then.
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { parseNotify } from "@/lib/notify-text";
import { renderMathInto } from "@/lib/math-render-lazy";

function Formula({ expression }: { expression: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) renderMathInto(ref.current, expression, true);
  }, [expression]);
  return (
    <span ref={ref} className="math-inline" data-math={expression} role="math" aria-label={expression}>
      {expression}
    </span>
  );
}

function lines(text: string, key: string): ReactNode {
  if (!text.includes("\n")) return text;
  return text.split("\n").map((part, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {part}
    </Fragment>
  ));
}

export function NotificationText({ value, members }: { value: string; members: { id: string; name: string }[] }) {
  const runs = parseNotify(value);
  const names = new Map(members.map((m) => [m.id.toLowerCase(), m.name]));
  const out: ReactNode[] = [];
  for (let i = 0; i < runs.length; ) {
    const href = runs[i].href;
    let j = i;
    const parts: ReactNode[] = [];
    while (j < runs.length && runs[j].href === href && (href || j === i)) {
      const run = runs[j];
      const k = `r${j}`;
      let node: ReactNode;
      if (run.math) node = <Formula expression={run.text} />;
      else if (run.mention && names.has(run.mention))
        node = (
          <span className="mention" data-mention={run.mention}>
            @{names.get(run.mention)}
          </span>
        );
      else node = run.code ? <code>{run.text}</code> : lines(run.text, k);
      if (run.strike) node = <s>{node}</s>;
      if (run.underline) node = <u>{node}</u>;
      if (run.italic) node = <em>{node}</em>;
      if (run.bold) node = <strong>{node}</strong>;
      parts.push(<Fragment key={k}>{node}</Fragment>);
      j++;
    }
    out.push(
      href ? (
        <a key={`a${i}`} href={href} target="_blank" rel="noopener noreferrer">
          {parts}
        </a>
      ) : (
        <Fragment key={`t${i}`}>{parts}</Fragment>
      ),
    );
    i = j;
  }
  return <span className="inline-text notification-text">{out}</span>;
}
