"use client";
import { tr } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/server-message";
import { applyPrintOptions, printOptionsCss, type PrintOptions } from "@/lib/print-options";
import { nativeApp } from "@/lib/native-app";
import { absoluteCssUrls, APP_PRINT_IMAGE_BUDGET, APP_PRINT_MAX_CHARS, printWay, styleText, type AppPrintRequest } from "@/lib/print-way";
import { showToast } from "./toast";
// Printing (and "Save as PDF"): the page content alone, as a lean copy –
// Safari lays out the whole app before showing its print dialog, which takes
// long. Started after the menu has closed – Safari ignores print() while a
// menu holds the page. `options` (#215, components/print-dialog.tsx) leave
// parts out of the copy and set paper, page numbers and the look; without
// them it prints as before.
export function printPage(root?: HTMLElement, options?: PrintOptions) {
  setTimeout(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const source = root || document.querySelector<HTMLElement>(".page-content");
    if (!source) return window.print();
    document.querySelector("iframe.print-frame")?.remove();
    document.querySelector(".print-copy")?.remove();
    const way = currentWay();
    // The iPhone/iPad and Android app prints itself (#424): the same copy,
    // with its styles and pictures inside, goes to the system's print dialog.
    if (way === "app")
      return void printInApp(async () => {
        const copy = leanCopy(source, document, options);
        await inlineImages(copy, APP_PRINT_IMAGE_BUDGET);
        return `<!doctype html><html lang="${escapeHtml(document.documentElement.lang)}" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="${escapeHtml(location.origin)}/"><title>${escapeHtml(document.title)}</title>${await inlinedStyles()}${optionsStyle(options)}</head><body class="print-view">${copy.outerHTML}</body></html>`;
      }, options?.paper);
    // Apps on the iPhone and iPad home screen cannot print at all: the view
    // opens in the browser instead.
    if (way === "browser")
      return void printInBrowser(async () => {
        const copy = leanCopy(source, document, options);
        await inlineImages(copy);
        return `<!doctype html><html lang="${escapeHtml(document.documentElement.lang)}" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(document.title)}</title>${appStyles()}${optionsStyle(options)}</head><body class="print-view">${copy.outerHTML}</body></html>`;
      });
    // iPhone and iPad print the page itself, not a frame, and only while the
    // tap still counts: the copy goes into the page, printed right away.
    if (way === "in-page") {
      const style = document.createElement("style");
      style.textContent = options ? printOptionsCss(options, "page") : "";
      return printInPage([style, leanCopy(source, document, options)]);
    }
    // Elsewhere in a hidden frame with the app's styles.
    const styles = [...document.head.querySelectorAll('link[rel="stylesheet"], style')].map((el) => el.outerHTML).join("");
    printInFrame(
      `<!doctype html><html lang="${document.documentElement.lang}" data-theme="light"><head><meta charset="utf-8"><base href="${location.origin}/"><title>${document.title.replace(/</g, "&lt;")}</title>${styles}${optionsStyle(options)}</head><body class="print-view"></body></html>`,
      (doc) => doc.body.append(doc.importNode(leanCopy(source, doc, options), true)),
    );
  }, 120);
}
// A complete print view from the server (the combined PDF export,
// app/api/export/pdf): printed the same three ways as a page – its pictures
// are addresses behind the session, so the home screen app sends them along
// as data.
export function printDocument(html: string) {
  setTimeout(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.querySelector("iframe.print-frame")?.remove();
    document.querySelector(".print-copy")?.remove();
    const way = currentWay();
    if (way === "app")
      return void printInApp(async () => {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        await inlineImages(parsed.body, APP_PRINT_IMAGE_BUDGET);
        const base = parsed.createElement("base");
        base.href = `${location.origin}/`;
        parsed.head.prepend(base);
        return `<!doctype html>${parsed.documentElement.outerHTML}`;
      }, null);
    if (way === "browser")
      return void printInBrowser(async () => {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        await inlineImages(parsed.body);
        return `<!doctype html>${parsed.documentElement.outerHTML}`;
      });
    if (way === "in-page") {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      return printInPage([...parsed.head.querySelectorAll("style"), ...parsed.body.children].map((el) => document.importNode(el, true) as HTMLElement));
    }
    printInFrame(html.replace(/<head>/i, `<head><base href="${location.origin}/">`));
  }, 120);
}
// The options' style sheet (lib/print-options.ts), after the app's.
const optionsStyle = (options?: PrintOptions) => {
  const css = options ? printOptionsCss(options, "page") : "";
  return css ? `<style data-print-options>${css.replace(/<\//g, "<\\/")}</style>` : "";
};
const currentWay = () => printWay({ app: nativeApp(), ios: isIOS(), standalone: isStandalone() });
const isStandalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const appStyles = () =>
  [...document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')]
    .map((el) => (el instanceof HTMLLinkElement ? `<link rel="stylesheet" href="${escapeHtml(el.href)}">` : `<style>${el.textContent}</style>`))
    .join("");
// The app's own copy has no address to load the styles from (the app's
// printing renders it apart from the instance, without a session or the
// instance's certificate): the instance's sheets go inside, their fonts and
// pictures at absolute addresses. Sheets from elsewhere stay links.
async function inlinedStyles() {
  const sheets = [...document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')];
  const parts = await Promise.all(
    sheets.map(async (el) => {
      if (!(el instanceof HTMLLinkElement)) return `<style>${styleText(absoluteCssUrls(el.textContent || "", location.href))}</style>`;
      try {
        if (new URL(el.href).origin === location.origin) {
          const res = await fetch(el.href, { credentials: "same-origin" });
          if (res.ok) return `<style>${styleText(absoluteCssUrls(await res.text(), el.href))}</style>`;
        }
      } catch {}
      return `<link rel="stylesheet" href="${escapeHtml(el.href)}">`;
    }),
  );
  return parts.join("");
}
// The app prints (FlowplanApp.print, #424): the system's print dialog, with
// a printer or "Save as PDF". Too big for one request (pictures as data):
// said so, nothing printed.
async function printInApp(build: () => Promise<string>, paper: PrintOptions["paper"] | null | undefined) {
  const app = nativeApp();
  if (!app?.print) return;
  try {
    const html = await build();
    if (html.length > APP_PRINT_MAX_CHARS)
      return void showToast({
        tone: "error",
        text: tr(
          "Die Seite ist zu groß, um sie in der App zu drucken (höchstens 25 MB mit Bildern). Lass Titelbild oder große Bilder weg oder drucke im Browser.",
          "The page is too large to print in the app (25 MB at most, pictures included). Leave out the cover or large pictures, or print in the browser.",
        ),
      });
    const request: AppPrintRequest = { html, title: document.title, paper: paper === "a4" || paper === "letter" ? paper : null };
    app.print(request);
  } catch {
    showToast({ tone: "error", text: tr("Druckansicht konnte nicht erstellt werden.", "The print view could not be created.") });
  }
}
// The copy goes into the page itself (iPhone, iPad), printed right away.
function printInPage(elements: HTMLElement[]) {
  const holder = document.createElement("div");
  holder.className = "print-copy";
  holder.setAttribute("aria-hidden", "true");
  holder.append(...elements);
  document.body.append(holder);
  document.documentElement.classList.add("printing-copy");
  const done = () => {
    document.documentElement.classList.remove("printing-copy");
    holder.remove();
  };
  window.addEventListener("afterprint", done, { once: true });
  window.print();
}
// A hidden frame holds the document; it prints once pictures and fonts are
// there (or after three seconds).
function printInFrame(html: string, fill?: (doc: Document) => void) {
  const frame = document.createElement("iframe");
  frame.className = "print-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  fill?.(doc);
  const ready = async () => {
    const images = [...doc.images].map((img) => (img.complete ? null : new Promise((done) => ((img.onload = img.onerror = done)))));
    await Promise.race([Promise.all([...images, doc.fonts?.ready]), new Promise((done) => setTimeout(done, 3000))]);
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
  };
  // Styles from <link> load in the frame first.
  if (doc.readyState === "complete") void ready();
  else frame.addEventListener("load", () => void ready(), { once: true });
}
// The print view as a document of its own (lib/print-snapshots.ts), stored
// briefly under a secret address and opened in the browser, where printing
// works. The browser there has no session: own pictures go along as data.
async function printInBrowser(build: () => Promise<string>) {
  document.querySelector("dialog.print-handoff")?.remove();
  const dialog = document.createElement("dialog");
  dialog.className = "print-handoff";
  const heading = document.createElement("h2");
  heading.textContent = tr("Drucken / PDF", "Print / PDF");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = tr("Druckansicht wird vorbereitet …", "Preparing the print view …");
  const actions = document.createElement("div");
  actions.className = "print-handoff-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = tr("Schließen", "Close");
  close.addEventListener("click", () => dialog.close());
  actions.append(close);
  dialog.append(heading, status, actions);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  try {
    const html = await build();
    const res = await fetch("/api/print", { method: "POST", headers: { "Content-Type": "text/html; charset=utf-8" }, body: html });
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !body.url) throw new Error(body.error ? serverMessage(body.error) : tr("Druckansicht konnte nicht erstellt werden.", "The print view could not be created."));
    const url = new URL(body.url, location.href).href;
    status.textContent = tr(
      "Apps auf dem Home-Bildschirm können nicht selbst drucken. Öffne die Druckansicht im Browser und tippe dort auf „Drucken / PDF“ oder auf Teilen → Drucken.",
      "Apps on the Home Screen cannot print themselves. Open the print view in the browser and tap “Print / PDF” there, or Share → Print.",
    );
    const open = document.createElement("a");
    open.className = "print-handoff-open";
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = tr("Druckansicht öffnen", "Open print view");
    open.addEventListener("click", () => setTimeout(() => dialog.close(), 500));
    actions.prepend(open);
    // Safari itself, if the first link stays in the app (iOS 17 and later).
    if (url.startsWith("https://")) {
      const safari = document.createElement("a");
      safari.href = `x-safari-${url}`;
      safari.textContent = tr("In Safari öffnen", "Open in Safari");
      safari.addEventListener("click", () => setTimeout(() => dialog.close(), 500));
      open.after(safari);
    }
    open.focus();
  } catch (e) {
    status.textContent = (e as Error).message || tr("Druckansicht konnte nicht erstellt werden.", "The print view could not be created.");
  }
}
// Own pictures (behind the session) as data, up to 30 MB together (the
// app: less, its request has a limit).
async function inlineImages(root: HTMLElement, budget = 30 * 1024 * 1024) {
  await Promise.all(
    [...root.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      const url = new URL(src, location.href);
      if (url.origin !== location.origin) return;
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) return;
        const blob = await res.blob();
        if (blob.size > budget) return;
        budget -= blob.size;
        img.src = await new Promise<string>((done, fail) => {
          const reader = new FileReader();
          reader.onload = () => done(reader.result as string);
          reader.onerror = fail;
          reader.readAsDataURL(blob);
        });
      } catch {}
    }),
  );
}
// Also iPads that present themselves as a Mac.
const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// A copy of the page content that prints like the original.
function leanCopy(source: HTMLElement, doc: Document, options?: PrintOptions) {
  const copy = source.cloneNode(true) as HTMLElement;
  // Drawings on a canvas do not survive copying: as pictures instead.
  const canvases = source.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((canvas, i) => {
    try {
      const img = doc.createElement("img");
      img.src = canvases[i].toDataURL("image/png");
      img.style.width = `${canvases[i].clientWidth}px`;
      img.style.maxWidth = "100%";
      canvas.replaceWith(img);
    } catch {}
  });
  // Typed values (the title, fields) are not part of a copy: as text instead.
  const fields = source.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea");
  copy.querySelectorAll<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea").forEach((field, i) => {
    const text = document.createElement("div");
    text.className = field.className;
    text.textContent = fields[i]?.value ?? "";
    text.style.whiteSpace = "pre-wrap";
    field.replaceWith(text);
  });
  copy.querySelectorAll<HTMLInputElement>("input[type=checkbox], input[type=radio]").forEach((box, i) => {
    if ((source.querySelectorAll<HTMLInputElement>("input[type=checkbox], input[type=radio]")[i] || box).checked) box.setAttribute("checked", "");
  });
  // Pictures load right away (a lazy one in a hidden copy never would), at
  // the address given.
  copy.querySelectorAll("img").forEach((img) => {
    img.removeAttribute("loading");
    img.removeAttribute("srcset");
  });
  // No second element with the same id, no editing in the copy.
  copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  copy.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  // Cover, icon, tags and properties as chosen (#215).
  if (options) applyPrintOptions(copy, options);
  return copy;
}
