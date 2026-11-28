// Random editor documents for property-based tests (fast-check): headings,
// paragraphs, lists, task lists, tables, code, quotes and columns, with links and
// marks over nasty text (tests/helpers/properties.ts), as HTML.
import fc from "fast-check";
import { nastyText } from "./properties";

const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const text = nastyText(6).filter((t) => /\S/.test(t));
type Inline = { text: string; marks: string[]; href?: string };
const MARKS = ["strong", "em", "s", "u", "code"];
type Options = { markdown?: boolean; marks?: boolean };
const inline = ({ markdown = false, marks = true }: Options): fc.Arbitrary<Inline> =>
  fc
    .record({
      text,
      marks: marks ? fc.subarray(MARKS, { maxLength: 2 }) : fc.constant<string[]>([]),
      href: !marks
        ? fc.constant(undefined)
        : fc.option(fc.constantFrom("https://example.test/a", "https://example.test/a?b=1&c=(2)", "/#page=abc", "mailto:a@example.test"), { nil: undefined }),
    })
    .map((run) => {
      let text = run.text;
      if (!markdown) return run;
      // Not the property's business: a Markdown delimiter cannot follow or
      // precede white space inside it, so lib/markdown.ts moves spaces at a
      // mark's edges out of it ("<s>a </s>" → "~~a~~ ") by design.
      if (run.marks.length) text = text.trim();
      // Known limitation, reported: marked does not give code inside a link's
      // text precedence over the link: a "]" in it ends the link, single
      // backticks are paired across code spans and "\]" loses its backslash.
      if (run.href && run.marks.includes("code")) text = text.replace(/[`\\[\]]/g, "");
      // Known limitation, reported: marked ends a table row at a line
      // separator, and inside code it cannot be written as a reference.
      if (run.marks.includes("code")) text = text.replace(/[\u2028\u2029]/g, " ");
      return { ...run, text: /\S/.test(text) ? text : "x" };
    });
const inlineHtml = (runs: Inline[]) =>
  runs
    .map((run) => {
      let html = escaped(run.text);
      for (const mark of run.marks) html = `<${mark}>${html}</${mark}>`;
      return run.href ? `<a href="${escaped(run.href)}">${html}</a>` : html;
    })
    .join("");
const blocks = (options: Options) => {
  const markdown = !!options.markdown;
  const runs = fc.array(inline(options), { minLength: 1, maxLength: 4 });
  const paragraph = runs.map((r) => `<p>${inlineHtml(r)}</p>`);
  const heading = fc.tuple(fc.integer({ min: 1, max: 3 }), runs).map(([level, r]) => `<h${level}>${inlineHtml(r)}</h${level}>`);
  const quote = paragraph.map((p) => `<blockquote>${p}</blockquote>`);
  return fc.oneof(
    { weight: 4, arbitrary: paragraph },
    { weight: 2, arbitrary: heading },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.constantFrom("ul", "ol"), fc.array(runs, { minLength: 1, maxLength: 3 }))
        .map(([tag, items]) => `<${tag}>${items.map((r) => `<li><p>${inlineHtml(r)}</p></li>`).join("")}</${tag}>`),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(fc.tuple(fc.boolean(), runs), { minLength: 1, maxLength: 3 })
        .map(
          (items) =>
            `<ul data-type="taskList">${items
              .map(([done, r]) => `<li data-type="taskItem" data-checked="${done}"><p>${inlineHtml(r)}</p></li>`)
              .join("")}</ul>`,
        ),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }))
        .chain(([cols, rows]) =>
          fc
            .array(fc.array(runs, { minLength: cols, maxLength: cols }), { minLength: rows + 1, maxLength: rows + 1 })
            .map(
              (cells) =>
                `<table>${cells
                  .map(
                    (row, r) => `<tr>${row.map((cell) => (r ? `<td><p>${inlineHtml(cell)}</p></td>` : `<th><p>${inlineHtml(cell)}</p></th>`)).join("")}</tr>`,
                  )
                  .join("")}</table>`,
            ),
        ),
    },
    {
      weight: 1,
      // Known limitation, reported: for Markdown, code ends with a line
      // break here, as every import writes it. A block without one gains it
      // through Markdown (fencedCode cannot tell them apart, marked adds
      // it), and a block of only a line break comes back empty.
      arbitrary: fc
        .tuple(
          fc.constantFrom("", "ts", "python", "c++"),
          nastyText(10).filter((code) => !markdown || /[^\r\n]/.test(code)),
        )
        .map(
          ([language, code]) =>
            `<pre><code${language ? ` class="language-${language}"` : ""}>${escaped(markdown ? code.replace(/\n?$/, "\n") : code)}</code></pre>`,
        ),
    },
    { weight: 1, arbitrary: quote },
    // Columns (lib/columns-block.ts), some resized; not in Markdown, which
    // shows them one after another.
    ...(markdown
      ? []
      : [
          {
            weight: 1,
            arbitrary: fc
              .array(
                fc.tuple(
                  fc.array(fc.oneof(paragraph, heading, quote), { minLength: 1, maxLength: 2 }),
                  fc.option(fc.integer({ min: 20, max: 80 }), { nil: undefined }),
                ),
                { minLength: 2, maxLength: 3 },
              )
              .map(
                (columns) =>
                  `<div data-columns="true">${columns
                    .map(([inner, width]) => `<div data-column="true"${width ? ` data-width="${width}"` : ""}>${inner.join("")}</div>`)
                    .join("")}</div>`,
              ),
          },
        ]),
  );
};
// Random documents. `markdown`: only what Markdown can hold (see above);
// `marks: false`: no marks and links.
export const documentHtml = (options: Options = {}) => fc.array(blocks(options), { minLength: 1, maxLength: 5 }).map((parts) => parts.join(""));
