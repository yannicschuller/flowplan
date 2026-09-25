"use client";
import { useEffect, useRef } from "react";
import { mountDiagram } from "@/lib/mermaid-render";
import { renderMath } from "@/lib/math-render";
import { renderCode, languageLabel } from "@/lib/code-highlight";
// Callers provide server-sanitized HTML. Generated math is never stored as document content.
export function ReadOnlyDocument({
  html,
  className = "",
}: {
  html: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const diagrams = Array.from(
      root.querySelectorAll<HTMLElement>("[data-mermaid]"),
    ).map((element) => mountDiagram(element, element.dataset.mermaid || ""));
    for (const element of root.querySelectorAll<HTMLElement>("[data-math]")) {
      element.innerHTML = renderMath(
        element.dataset.math || "",
        element.tagName === "SPAN",
      );
    }
    for (const image of root.querySelectorAll("img")) image.loading = "lazy";
    for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
      const text = code.textContent || "";
      const language =
        Array.from(code.classList)
          .find((c) => c.startsWith("language-"))
          ?.slice(9) || null;
      code.innerHTML = renderCode(text, language);
      if (
        code.parentElement?.parentElement?.classList.contains("code-block-view")
      )
        continue;
      const pre = code.parentElement!,
        wrapper = document.createElement("div"),
        toolbar = document.createElement("div"),
        label = document.createElement("span"),
        copy = document.createElement("button");
      wrapper.className = "code-block-view";
      toolbar.className = "code-block-toolbar";
      label.textContent = languageLabel(language);
      copy.textContent = "Kopieren";
      copy.type = "button";
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = "Code kopiert";
        } catch {
          copy.textContent = "Kopieren fehlgeschlagen";
        }
      };
      toolbar.append(label, copy);
      pre.before(wrapper);
      wrapper.append(toolbar, pre);
    }
    // Embedded database tables: search and sort by column in the browser.
    for (const embed of root.querySelectorAll<HTMLElement>(".public-embed")) {
      const table = embed.querySelector("table");
      const body = table?.querySelector("tbody");
      if (!table || !body || embed.dataset.interactive) continue;
      embed.dataset.interactive = "true";
      const rows = Array.from(body.querySelectorAll("tr"));
      const search = document.createElement("input");
      search.type = "search";
      search.placeholder = "In dieser Ansicht suchen …";
      search.setAttribute("aria-label", "Eingebettete Ansicht durchsuchen");
      search.className = "public-embed-search";
      search.addEventListener("input", () => {
        const term = search.value.trim().toLocaleLowerCase("de");
        for (const row of rows)
          row.hidden =
            !!term && !row.textContent?.toLocaleLowerCase("de").includes(term);
      });
      table.before(search);
      table.querySelectorAll("th").forEach((th, column) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "public-embed-sort";
        button.textContent = th.textContent;
        th.setAttribute("aria-sort", "none");
        th.replaceChildren(button);
        button.addEventListener("click", () => {
          const ascending = th.getAttribute("aria-sort") !== "ascending";
          table
            .querySelectorAll("th")
            .forEach((other) => other.setAttribute("aria-sort", "none"));
          th.setAttribute("aria-sort", ascending ? "ascending" : "descending");
          const text = (row: Element) =>
            row.children[column]?.textContent?.trim() || "";
          rows.sort((a, b) => {
            const x = text(a),
              y = text(b);
            const nx = Number(x.replace(/\./g, "").replace(",", ".")),
              ny = Number(y.replace(/\./g, "").replace(",", "."));
            const order =
              x && y && !isNaN(nx) && !isNaN(ny)
                ? nx - ny
                : x.localeCompare(y, "de", { numeric: true });
            return ascending ? order : -order;
          });
          body.append(...rows);
        });
      });
    }
    return () => diagrams.forEach((cancel) => cancel());
  }, [html]);
  return (
    <div
      ref={ref}
      className={`document-editor ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
