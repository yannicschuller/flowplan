"use client";
import { useEffect, useState } from "react";
import { Truck } from "@phosphor-icons/react";
import { useT } from "./i18n";
import type { ReadOnlyState } from "@/lib/instance-read-only";

// An instance that is moving (lib/instance-move.ts): read-only for the final
// sync, or moved to its new address. A banner for everyone, signed in or
// not, that cannot be hidden; open tabs check again every minute.
export function MoveBanner({ initial, poll }: { initial: ReadOnlyState; poll: boolean }) {
  const t = useT();
  const [state, setState] = useState(initial);
  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(async () => {
      try {
        const answer = await fetch("/api/maintenance", { cache: "no-store" });
        if (answer.ok) {
          const move = ((await answer.json()) as { move?: ReadOnlyState }).move;
          if (move) setState(move);
        }
      } catch {}
    }, 60_000);
    return () => clearInterval(timer);
  }, [poll]);
  if (!state.readOnly) return null;
  return (
    <div className="move-banner" role="status">
      <Truck size={16} aria-hidden />
      {state.movedTo ? (
        <span>
          {t("Diese Instanz ist umgezogen nach", "This instance has moved to")} <a href={state.movedTo}>{state.movedTo}</a>.{" "}
          {t("Änderungen sind nur noch dort möglich.", "Changes are only possible there.")}
        </span>
      ) : (
        <span>
          <strong>{t("Umzug läuft:", "Move in progress:")}</strong>{" "}
          {t("Diese Instanz ist schreibgeschützt. Lesen geht weiter; Änderungen sind erst auf der neuen Instanz wieder möglich.", "This instance is read-only. Reading still works; changes are possible again on the new instance.")}
        </span>
      )}
    </div>
  );
}
