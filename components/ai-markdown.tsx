"use client";
// AI answers as Markdown: headings, lists (also nested), bold, italic,
// code, quotes and links – rendered as React elements, never as HTML from
// the answer. Plain text goes through `renderText`, which turns citations
// like [1] into buttons (components/ai-ask.tsx).
import { Fragment, type ReactNode } from "react";
import { Marked, type Token, type Tokens } from "marked";

const marked = new Marked({ gfm: true, breaks: true });

// Links: only to the web and to mail addresses.
const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null);

type TextRenderer = (text: string, key: string) => ReactNode;

function inline(tokens: Token[] | undefined, renderText: TextRenderer, prefix: string): ReactNode[] {
  return (tokens || []).map((token, i) => {
    const key = `${prefix}.${i}`;
    switch (token.type) {
      case "strong":
        return <strong key={key}>{inline((token as Tokens.Strong).tokens, renderText, key)}</strong>;
      case "em":
        return <em key={key}>{inline((token as Tokens.Em).tokens, renderText, key)}</em>;
      case "del":
        return <del key={key}>{inline((token as Tokens.Del).tokens, renderText, key)}</del>;
      case "codespan":
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={key} />;
      case "link": {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        const label = inline(link.tokens, renderText, key);
        return href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <Fragment key={key}>{label}</Fragment>
        );
      }
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens?.length ? <Fragment key={key}>{inline(text.tokens, renderText, key)}</Fragment> : <Fragment key={key}>{renderText(unescape(text.text), key)}</Fragment>;
      }
      case "escape":
        return <Fragment key={key}>{renderText((token as Tokens.Escape).text, key)}</Fragment>;
      default:
        // HTML and anything unknown: as the text it is.
        return <Fragment key={key}>{renderText(unescape(token.raw), key)}</Fragment>;
    }
  });
}

// marked escapes &, <, > … in text tokens; React escapes on its own.
const unescape = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]!);

function blocks(tokens: Token[], renderText: TextRenderer, prefix: string): ReactNode[] {
  return tokens.map((token, i) => {
    const key = `${prefix}-${i}`;
    switch (token.type) {
      case "space":
        return null;
      case "heading": {
        const heading = token as Tokens.Heading;
        const Tag = heading.depth <= 2 ? "h3" : heading.depth === 3 ? "h4" : "h5";
        return <Tag key={key}>{inline(heading.tokens, renderText, key)}</Tag>;
      }
      case "paragraph":
        return <p key={key}>{inline((token as Tokens.Paragraph).tokens, renderText, key)}</p>;
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item, j) => (
          <li key={`${key}.${j}`}>
            {item.task && <input type="checkbox" checked={!!item.checked} readOnly disabled aria-hidden="true" />}
            {blocks(item.tokens, renderText, `${key}.${j}`)}
          </li>
        ));
        return list.ordered ? (
          <ol key={key} start={typeof list.start === "number" && list.start !== 1 ? list.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "blockquote":
        return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, renderText, key)}</blockquote>;
      case "code":
        return (
          <pre key={key}>
            <code>{(token as Tokens.Code).text}</code>
          </pre>
        );
      case "hr":
        return <hr key={key} />;
      case "table": {
        const table = token as Tokens.Table;
        return (
          <div key={key} className="ai-md-table">
            <table>
              <thead>
                <tr>
                  {table.header.map((cell, j) => (
                    <th key={j}>{inline(cell.tokens, renderText, `${key}.h${j}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, j) => (
                      <td key={j}>{inline(cell.tokens, renderText, `${key}.${r}.${j}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "text": {
        // Text directly in a list item ("tight" lists).
        const text = token as Tokens.Text;
        return <Fragment key={key}>{text.tokens?.length ? inline(text.tokens, renderText, key) : renderText(unescape(text.text), key)}</Fragment>;
      }
      default:
        return <p key={key}>{renderText(unescape(token.raw), key)}</p>;
    }
  });
}

export function AiMarkdown({ text, renderText = (t) => t, after }: { text: string; renderText?: TextRenderer; after?: ReactNode }) {
  let tokens: Token[];
  try {
    tokens = marked.lexer(text);
  } catch {
    return (
      <div className="ai-md">
        <p>
          {renderText(text, "raw")}
          {after}
        </p>
      </div>
    );
  }
  return (
    <div className="ai-md">
      {blocks(tokens, renderText, "b")}
      {after}
    </div>
  );
}
