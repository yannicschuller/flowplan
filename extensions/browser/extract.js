// Flowplan web clipper – reading the page. Injected into the active tab on
// demand (never on every page), and loaded by the Node tests with a DOM
// (tests/clipper-extension.test.ts). A plain script without imports so it
// runs as a content script in Chromium and Firefox alike; the result is
// sanitised again by the server (lib/clipper.ts).
(function (root) {
  "use strict";
  const REMOVE =
    "script,style,noscript,iframe,frame,form,button,input,select,textarea,svg,canvas,nav,aside,footer,template,object,embed,dialog,link,meta";
  const NEGATIVE =
    /(^|[\s_-])(comment|comments|meta|footer|footnote|sidebar|sponsor|share|sharing|social|related|promo|advert|ads?|banner|cookie|consent|nav|navbar|menu|breadcrumbs?|subscribe|newsletter|popup|modal|toolbar|masthead|widget|outbrain|taboola|byline-tools)([\s_-]|$)/i;
  const POSITIVE = /(^|[\s_-])(article|body|content|entry|main|page|post|text|blog|story|prose|markdown)([\s_-]|$)/i;
  const BLOCKS = "p,pre,td,blockquote,li,h2,h3,h4,dd,figcaption";

  const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  const absolute = (value, base) => {
    try {
      return new URL(value, base).toString();
    } catch {
      return "";
    }
  };
  const metaContent = (doc, names) => {
    for (const name of names) {
      const el = doc.querySelector(`meta[property="${name}"],meta[name="${name}"]`);
      const value = el && el.getAttribute("content");
      if (value && value.trim()) return value.trim();
    }
    return "";
  };

  // Title, description, favicon and address of the page.
  function meta(doc) {
    const url = doc.URL || (doc.location && doc.location.href) || "";
    const base = doc.baseURI || url;
    const icon = doc.querySelector('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]');
    let favicon = icon ? absolute(icon.getAttribute("href") || "", base) : "";
    if (!favicon && /^https?:/.test(url)) favicon = absolute("/favicon.ico", url);
    return {
      url,
      title: (metaContent(doc, ["og:title", "twitter:title"]) || doc.title || "").trim().slice(0, 300),
      description: metaContent(doc, ["description", "og:description", "twitter:description"]).slice(0, 2000),
      favicon: /^https:/.test(favicon) ? favicon : "",
      site: metaContent(doc, ["og:site_name"]),
    };
  }

  const linkDensity = (el) => {
    const total = textOf(el).length || 1;
    let links = 0;
    for (const a of el.querySelectorAll("a")) links += textOf(a).length;
    return links / total;
  };
  const classWeight = (el) => {
    const names = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
    let weight = 0;
    if (NEGATIVE.test(names)) weight -= 25;
    if (POSITIVE.test(names)) weight += 25;
    return weight;
  };

  // Removes what is never part of an article: scripts, forms, navigation,
  // hidden elements and boxes whose class names say they are clutter.
  function clean(container) {
    for (const el of [...container.querySelectorAll(REMOVE)]) el.remove();
    for (const el of [...container.querySelectorAll('[hidden],[aria-hidden="true"],[role="navigation"],[role="banner"],[role="complementary"],[role="dialog"]')])
      el.remove();
    for (const el of [...container.querySelectorAll("div,section,ul,header,span,p,figure")]) {
      if (!container.contains(el)) continue;
      const names = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`;
      if (NEGATIVE.test(names) && !POSITIVE.test(names) && !el.querySelector("article,main")) el.remove();
    }
    return container;
  }

  // Readability-style: paragraphs give points to their parent (and half to
  // the grandparent); the best container, weighted by how little of it is
  // links, is the article. Siblings that score well or read like text are
  // kept with it.
  function extractArticle(doc) {
    const info = meta(doc);
    const body = doc.body ? clean(doc.body.cloneNode(true)) : null;
    if (!body) return { ...info, html: "", text: "" };
    const scores = new Map();
    const add = (el, points) => {
      if (!el || el === body.parentNode) return;
      if (!scores.has(el)) scores.set(el, classWeight(el) + (/^(ARTICLE|MAIN)$/.test(el.tagName) ? 30 : /^(DIV|SECTION)$/.test(el.tagName) ? 5 : 0));
      scores.set(el, scores.get(el) + points);
    };
    for (const block of body.querySelectorAll(BLOCKS)) {
      const text = textOf(block);
      if (text.length < 25) continue;
      const points = 1 + (text.match(/[,،、，]/g) || []).length + Math.min(3, Math.floor(text.length / 100));
      add(block.parentElement, points);
      if (block.parentElement) add(block.parentElement.parentElement, points / 2);
    }
    let best = null,
      bestScore = 0;
    for (const [el, score] of scores) {
      const final = score * (1 - linkDensity(el));
      if (final > bestScore) {
        best = el;
        bestScore = final;
      }
    }
    if (!best) best = body.querySelector("article") || body.querySelector("main") || body;
    // Siblings: well-scored ones and plain long paragraphs.
    const parts = [];
    const parent = best.parentElement;
    if (parent && best !== body) {
      const threshold = Math.max(10, bestScore * 0.2);
      for (const sibling of parent.children) {
        if (sibling === best) parts.push(sibling);
        else if ((scores.get(sibling) || 0) * (1 - linkDensity(sibling)) >= threshold) parts.push(sibling);
        else if (sibling.tagName === "P" && textOf(sibling).length > 80 && linkDensity(sibling) < 0.25) parts.push(sibling);
      }
    } else parts.push(best);
    const container = doc.createElement("div");
    for (const part of parts) container.appendChild(part.cloneNode(true));
    // Leftovers inside the article: short link lists and empty boxes.
    for (const el of [...container.querySelectorAll("ul,ol,div,section")]) {
      if (!container.contains(el)) continue;
      const text = textOf(el);
      if (!text && !el.querySelector("img,video,picture")) el.remove();
      else if (text.length < 200 && linkDensity(el) > 0.5 && !el.querySelector("img")) el.remove();
    }
    absolutize(container, doc.baseURI || info.url);
    // The heading that repeats the title is left out.
    const first = container.querySelector("h1");
    if (first && textOf(first).toLowerCase() === info.title.toLowerCase()) first.remove();
    return { ...info, html: container.innerHTML.trim(), text: textOf(container) };
  }

  // Links and images relative to the page become absolute; lazy images get
  // their real source.
  function absolutize(container, base) {
    for (const a of container.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#") || /^javascript:/i.test(href)) a.removeAttribute("href");
      else a.setAttribute("href", absolute(href, base));
    }
    for (const img of container.querySelectorAll("img")) {
      const lazy = img.getAttribute("data-src") || img.getAttribute("data-original") || ((img.getAttribute("srcset") || "").split(",")[0] || "").trim().split(/\s+/)[0];
      const src = img.getAttribute("src");
      const chosen = !src || src.startsWith("data:") ? lazy || src : src;
      if (chosen && !chosen.startsWith("data:")) img.setAttribute("src", absolute(chosen, base));
      else img.remove();
      img.removeAttribute("srcset");
    }
    return container;
  }

  // The selected part of the page as HTML (all ranges) and as text.
  function selection(win) {
    const doc = win.document;
    const sel = win.getSelection && win.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return { html: "", text: "" };
    const container = doc.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) container.appendChild(sel.getRangeAt(i).cloneContents());
    for (const el of [...container.querySelectorAll(REMOVE)]) el.remove();
    absolutize(container, doc.baseURI || doc.URL);
    return { html: container.innerHTML.trim(), text: String(sel.toString()).trim().slice(0, 20000) };
  }

  // What the popup or the context menu needs for a mode.
  function collect(mode, win) {
    const w = win || root;
    const doc = w.document;
    if (mode === "page") return extractArticle(doc);
    if (mode === "selection" || mode === "highlight") return { ...meta(doc), ...selection(w) };
    return meta(doc);
  }

  root.FlowplanExtract = { meta, extractArticle, selection, collect, absolutize };
})(globalThis);
