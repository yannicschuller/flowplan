// Editor views for citations (lib/citation-nodes.ts): the inline label with
// the full reference as tooltip, and the bibliography that follows every
// citation in the document. Plain DOM, text only.
import { Bibliography, Citation } from "@/lib/citation-nodes";
import {
  citedWorks,
  formatReference,
  inlineCitation,
  parseItemAttribute,
  referenceText,
  type CslItem,
} from "@/lib/citations";
import { tr } from "@/lib/locale-tag";

// The references as list items; links only for http(s) addresses.
export function renderReferences(list: HTMLElement, items: CslItem[], empty: string) {
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "bibliography-empty";
    li.textContent = empty;
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.id = `ref-${item.id}`;
      for (const part of formatReference(item, tr)) {
        if (/^https?:\/\/\S+$/.test(part.text)) {
          const a = document.createElement("a");
          a.href = part.text;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = part.text;
          li.append(a);
        } else if (part.italic) {
          const em = document.createElement("em");
          em.textContent = part.text;
          li.append(em);
        } else li.append(document.createTextNode(part.text));
      }
      return li;
    }),
  );
}
export const emptyBibliography = () =>
  tr("Noch keine Zitate in diesem Dokument – mit /zitat einfügen.", "No citations in this document yet – insert them with /cite.");

export const CitationView = Citation.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "citation";
      let current = node;
      const draw = () => {
        const item = parseItemAttribute(current.attrs.item);
        dom.textContent = inlineCitation(item, current.attrs.locator, tr);
        dom.title = item ? referenceText(item, tr) : "";
      };
      draw();
      return {
        dom,
        update: (next) => {
          if (next.type !== current.type) return false;
          current = next;
          draw();
          return true;
        },
      };
    };
  },
});

export const BibliographyView = Bibliography.extend({
  addNodeView() {
    return ({ node, editor }) => {
      const dom = document.createElement("div"),
        title = document.createElement("p"),
        list = document.createElement("ul");
      dom.className = "bibliography";
      dom.contentEditable = "false";
      title.className = "bibliography-title";
      list.className = "bibliography-list";
      dom.append(title, list);
      let current = node,
        drawn = "";
      const draw = () => {
        const cited: { key: string; item: string }[] = [];
        editor.state.doc.descendants((n) => {
          if (n.type.name === "citation") cited.push({ key: String(n.attrs.key || ""), item: String(n.attrs.item || "") });
        });
        const signature = JSON.stringify([current.attrs.title, cited]);
        if (signature === drawn) return;
        drawn = signature;
        title.textContent = current.attrs.title || tr("Literaturverzeichnis", "References");
        renderReferences(list, citedWorks(cited), emptyBibliography());
      };
      draw();
      editor.on("update", draw);
      return {
        dom,
        update: (next) => {
          if (next.type !== current.type) return false;
          current = next;
          draw();
          return true;
        },
        ignoreMutation: () => true,
        destroy: () => editor.off("update", draw),
      };
    };
  },
});
