"use client";
import { Truck } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { useInstanceNotices } from "./instance-notices";
import type { ReadOnlyState } from "@/lib/instance-read-only";

// An instance that is moving (lib/instance-move.ts): read-only for the final
// sync, or moved to its new address. A banner for everyone, signed in or
// not, that cannot be hidden. Open tabs of signed-in people hear of a change
// over the workspace's live stream, and poll only while it is not live
// (components/instance-notices.ts, #515).
export function MoveBanner({ initial, poll }: { initial: ReadOnlyState; poll: boolean }) {
  const t = useT();
  const state = useInstanceNotices({ move: initial }, poll).move;
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
