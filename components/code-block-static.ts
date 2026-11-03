"use client";
import { tr } from "@/lib/locale-tag";
import { loadLanguage, renderCode } from "@/lib/code-highlight";
import { languageLabel } from "@/lib/code-languages";
import {
  collapsedLines,
  effectiveView,
  highlightedLines,
  isCollapsed,
  lineCount,
  optionsFromAttributes,
  previewKind,
  startLine,
  type CodeView,
} from "@/lib/code-block-options";
import { lineNumbersByDefault } from "@/lib/code-block-prefs";
import { mountCodePreview } from "@/lib/code-preview";

// Highlighted HTML (lib/code-highlight.ts renderCode, whose spans never
// cross a line) with line numbers and highlighted lines (#93): each line
// starts with an empty marker whose number CSS draws (not selectable, not
// copied); a highlighted line's text is wrapped for its background.
export function numberedCode(html: string, text: string, numbered: boolean, first: number, marked: Set<number>) {
  if (!numbered && !marked.size) return html;
  const lines = html.split("\n");
  const count = lineCount(text);
  return lines
    .map((line, i) => {
      if (i >= count) return line;
      const highlighted = marked.has(i + 1);
      if (!numbered && !highlighted) return line;
      const mark = `<span class="code-line-number${highlighted ? " is-highlighted" : ""}${numbered ? "" : " is-mark"}"${numbered ? ` data-line="${first + i}"` : ""} aria-hidden="true"></span>`;
      return mark + (highlighted && line ? `<span class="code-line-highlight">${line}</span>` : line);
    })
    .join("\n");
}

let sequence = 0;
const started = new WeakMap<HTMLElement, () => () => void>();
// A code block of a read-only view (publications, feeds, presentations,
// read-only pages): toolbar with language, view switch and copy, line
// numbers, highlighting, the preview and collapsing – the reader's choices
// stay in the page. Returns what stops it.
export function enhanceCodeBlock(code: HTMLElement, isUnmounted: () => boolean) {
  const pre = code.parentElement as HTMLElement;
  const text = code.textContent || "";
  const language = Array.from(code.classList).find((c) => c.startsWith("language-"))?.slice(9) || null;
  const options = optionsFromAttributes((name) => pre.getAttribute(name), language);
  const numbered = options.lineNumbers ?? lineNumbersByDefault();
  const first = startLine(options.startLine);
  const marked = highlightedLines(options.highlightLines);
  const lines = lineCount(text);
  const draw = (html: string) => (code.innerHTML = numberedCode(html, text, numbered, first, marked));
  // Plain text until the language's grammar has loaded.
  draw(renderCode(text, null));
  if (numbered) pre.dataset.lineNumbers = "true";
  void loadLanguage(language).then((highlighted) => {
    if (highlighted && !isUnmounted() && code.isConnected) draw(renderCode(text, language));
  });
  // Already set up (the same root drawn again): its preview starts again.
  const again = started.get(pre);
  if (again && pre.closest(".code-block-view")) return again();

  const kind = previewKind(language, text);
  let view: CodeView = effectiveView(options.view, kind, false);
  const limit = collapsedLines(options.collapsedLines);
  let collapsed = isCollapsed(options.collapsed, lines, limit);
  const wrapper = document.createElement("div"),
    toolbar = document.createElement("div"),
    label = document.createElement("span"),
    actions = document.createElement("span"),
    copy = document.createElement("button"),
    body = document.createElement("div"),
    codeBox = document.createElement("div"),
    fade = document.createElement("div");
  wrapper.className = "code-block-view";
  wrapper.style.setProperty("--code-gutter", `${String(first + Math.max(0, lines - 1)).length}ch`);
  wrapper.style.setProperty("--code-collapsed-lines", String(limit));
  toolbar.className = "code-block-toolbar";
  label.textContent = languageLabel(language);
  actions.className = "code-block-actions";
  copy.textContent = tr("Kopieren", "Copy");
  copy.type = "button";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = tr("Code kopiert", "Code copied");
    } catch {
      copy.textContent = tr("Kopieren fehlgeschlagen", "Copying failed");
    }
  };
  body.className = "code-block-body";
  codeBox.className = "code-block-code";
  fade.className = "code-block-fade";
  fade.setAttribute("aria-hidden", "true");
  pre.id ||= `code-block-${++sequence}`;
  pre.before(wrapper);
  codeBox.append(pre);
  body.append(codeBox);
  toolbar.append(label);

  // Code, preview or split.
  let preview: HTMLDivElement | null = null,
    stopPreview = () => {};
  const buttons: [CodeView, HTMLButtonElement][] = [];
  const showView = () => {
    wrapper.dataset.view = view;
    for (const [option, button] of buttons) button.setAttribute("aria-pressed", String(option === view));
    stopPreview();
    if (kind && view !== "code") {
      if (!preview) {
        preview = document.createElement("div");
        preview.className = "code-block-preview";
        preview.setAttribute("role", "region");
        preview.setAttribute("aria-label", tr("Vorschau", "Preview"));
        body.append(preview);
      }
      stopPreview = mountCodePreview(preview, kind, text);
    } else {
      preview?.remove();
      preview = null;
      stopPreview = () => {};
    }
    expand.hidden = !collapsible || view === "preview";
  };
  if (kind) {
    const group = document.createElement("span");
    group.className = "code-view-switch";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", tr("Ansicht", "View"));
    const names: Record<CodeView, string> = { code: tr("Code", "Code"), preview: tr("Vorschau", "Preview"), split: tr("Geteilt", "Split") };
    for (const option of ["code", "preview", "split"] as CodeView[]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = names[option];
      button.onclick = () => {
        view = option;
        showView();
      };
      buttons.push([option, button]);
      group.append(button);
    }
    toolbar.append(group);
  }
  actions.append(copy);
  toolbar.append(actions);

  // Collapsed: a few lines that scroll inside, "Show all N lines" below.
  const collapsible = lines > limit;
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "code-block-expand";
  expand.setAttribute("aria-controls", pre.id);
  const showCollapsed = () => {
    wrapper.toggleAttribute("data-collapsed", collapsed);
    if (collapsed) wrapper.dataset.collapsed = "true";
    expand.setAttribute("aria-expanded", String(!collapsed));
    expand.textContent = collapsed ? tr(`Alle ${lines} Zeilen anzeigen`, `Show all ${lines} lines`) : tr("Einklappen", "Collapse");
    // A collapsed block scrolls inside: reachable by keyboard.
    if (collapsed) pre.tabIndex = 0;
    else pre.removeAttribute("tabindex");
    checkEnd();
  };
  const checkEnd = () => {
    fade.hidden = !collapsed || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  };
  pre.addEventListener("scroll", checkEnd, { passive: true });
  expand.onclick = () => {
    collapsed = !collapsed;
    showCollapsed();
  };
  codeBox.append(fade);
  wrapper.append(toolbar, body, expand);
  showCollapsed();
  const start = () => {
    showView();
    return () => stopPreview();
  };
  started.set(pre, start);
  return start();
}
