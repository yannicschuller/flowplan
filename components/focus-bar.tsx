"use client";
// Writing without distraction: sidebar and page chrome fade away, a small
// bar counts words towards an optional goal (kept per page on this device).
import { useT } from "./i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";

export function countWords(html: string) {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .trim();
  return text ? text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

export function FocusBar({
  pageId,
  html,
  onClose,
}: {
  pageId: string;
  html: () => string;
  onClose: () => void;
}) {
  const t = useT();
  const key = `flowplan:word-goal:${pageId}`;
  const [words, setWords] = useState(() => countWords(html()));
  const [start] = useState(() => countWords(html()));
  const [goal, setGoal] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(key)) || 0;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    const timer = setInterval(() => setWords(countWords(html())), 800);
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", key);
    };
  }, [html, onClose]);
  const saveGoal = (value: number) => {
    setGoal(value);
    try {
      if (value) localStorage.setItem(key, String(value));
      else localStorage.removeItem(key);
    } catch {}
  };
  const progress = goal ? Math.min(1, words / goal) : 0;
  return (
    <div className="focus-bar" role="status" aria-label={t("Fokusmodus", "Focus mode")}>
      <span className="focus-count">
        <strong>{words.toLocaleString(LOCALE_TAG)}</strong> {t("Wörter", "words")}
        {words - start > 0 && <small>+{(words - start).toLocaleString(LOCALE_TAG)} {t("in dieser Sitzung", "in this session")}</small>}
      </span>
      <label className="focus-goal">
        {t("Ziel", "Goal")}
        <input
          type="number"
          min={0}
          max={100000}
          step={50}
          inputMode="numeric"
          aria-label={t("Wortziel", "Word goal")}
          value={goal || ""}
          placeholder="—"
          onChange={(e) => saveGoal(Math.max(0, Math.min(100000, Number(e.target.value) || 0)))}
        />
      </label>
      {goal > 0 && (
        <span className={`focus-progress${progress >= 1 ? " done" : ""}`} aria-label={`${Math.round(progress * 100)} % des Ziels`}>
          <i style={{ width: `${progress * 100}%` }} />
        </span>
      )}
      {goal > 0 && progress >= 1 && <span className="focus-done">{t("Ziel erreicht 🎉", "Goal reached 🎉")}</span>}
      <button type="button" className="icon-button" aria-label={t("Fokusmodus beenden", "Exit focus mode")} onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
