"use client";
// Banners of the administration that each person clicks away once
// (lib/instance-banners.ts): above the page, with an optional link. Closing
// it or following the link hides it for good, on every device. "Only in the
// browser" banners stay away from the desktop app and the apps.
import { useState } from "react";
import { ArrowSquareOut, Info, Megaphone, Sparkle, Warning, X } from "@phosphor-icons/react";
import type { Banner } from "@/lib/instance-banners";
import { inDesktopApp, nativeApp } from "@/lib/native-app";
import { useT } from "./i18n";

const ICONS = { info: Info, promo: Megaphone, success: Sparkle, warning: Warning } as const;
const inAnApp = () => typeof window !== "undefined" && (!!nativeApp() || inDesktopApp() || "FlowplanApp" in window);
const external = (href: string) => /^https?:\/\//.test(href);

function seen(id: string, clicked: boolean) {
  void fetch("/api/banners", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "dismiss", id, clicked }),
    keepalive: true,
  }).catch(() => {});
}

// preview: the administration's preview – nothing is sent or remembered.
export function InstanceBanners({ initial, preview = false }: { initial: Banner[]; preview?: boolean }) {
  const t = useT();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const shown = initial.filter((b) => !gone.has(b.id) && (preview || !(b.surface === "browser" && inAnApp())));
  if (!shown.length) return null;
  const close = (b: Banner, clicked: boolean) => {
    if (preview) return;
    setGone((g) => new Set(g).add(b.id));
    seen(b.id, clicked);
  };
  return (
    <div className="instance-banners">
      {shown.map((b) => {
        const Icon = ICONS[b.tone] || Info;
        return (
          <div key={b.id} className={`instance-banner tone-${b.tone}`} role="note">
            <Icon size={16} weight={b.tone === "promo" ? "fill" : "regular"} aria-hidden />
            <span className="instance-banner-text">
              {b.title && <strong>{b.title}</strong>} {b.message}
            </span>
            {b.linkUrl && (
              <a
                className="instance-banner-link"
                href={b.linkUrl}
                {...(external(b.linkUrl) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                onClick={(e) => {
                  if (preview) e.preventDefault();
                  close(b, true);
                }}
              >
                {b.linkLabel || t("Mehr erfahren", "Learn more")}
                {external(b.linkUrl) && <ArrowSquareOut size={13} aria-hidden />}
              </a>
            )}
            <button type="button" className="instance-banner-close" aria-label={t("Hinweis schließen", "Close notice")} title={t("Schließen – erscheint nicht wieder", "Close – won't appear again")} onClick={() => close(b, false)}>
              <X size={14} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
