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
