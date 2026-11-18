// The reasons of a restart (lib/restarts/tracker.ts) as words: the
// Restarts card (monitoring-restarts.tsx, loaded when it comes into view)
// and the monitoring's event list (monitoring.tsx) share them.
type T = (de: string, en: string) => string;

export function reasonLabel(reason: string, t: T) {
  return (
    ({
      clean: t("Sauber beendet", "Clean"),
      crash: t("Absturz", "Crash"),
      oom: t("Vermutlich Speicher voll", "Likely out of memory"),
      killed: t("Ohne Spur beendet", "Killed without trace"),
    }) as Record<string, string>
  )[reason] || reason;
}
export const restartTitle = (reason: string, t: T) => t(`Unerwarteter Neustart: ${reasonLabel(reason, t)}`, `Unexpected restart: ${reasonLabel(reason, t)}`);
