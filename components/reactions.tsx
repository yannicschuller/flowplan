"use client";
// Emoji reactions under a comment (or on a block): existing reactions as
// buttons, and a small picker with frequent emojis.
import { useState } from "react";
import { Smiley } from "@phosphor-icons/react";
import type { Reaction } from "@/lib/types";

export const quickReactions = ["👍", "❤️", "🎉", "😄", "👀", "✅", "🙏", "🔥"];

export function Reactions({
  reactions,
  disabled,
  onToggle,
  label = "Reaktion hinzufügen",
}: {
  reactions: Reaction[];
  disabled?: boolean;
  onToggle: (emoji: string, active: boolean) => void | Promise<unknown>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reactions">
      {reactions.map((r) => (
        <button
          type="button"
          key={r.emoji}
          className="reaction-button"
          aria-pressed={r.mine}
          title={r.names.join(", ")}
          aria-label={`${r.emoji} ${r.count} ${r.count === 1 ? "Reaktion" : "Reaktionen"}`}
          disabled={disabled}
          onClick={() => void onToggle(r.emoji, !r.mine)}
        >
          {r.emoji} {r.count}
        </button>
      ))}
      <span className="reaction-add">
        <button
          type="button"
          className="icon-button"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen(!open)}
        >
          <Smiley size={16} />
        </button>
        {open && (
          <span className="reaction-picker" role="group" aria-label="Emoji wählen">
            {quickReactions.map((emoji) => (
              <button
                type="button"
                key={emoji}
                aria-label={`Mit ${emoji} reagieren`}
                onClick={() => {
                  setOpen(false);
                  const existing = reactions.find((r) => r.emoji === emoji);
                  void onToggle(emoji, !existing?.mine);
                }}
              >
                {emoji}
              </button>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}
