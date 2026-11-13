// Client side of the upgrade link (lib/upgrade-link.ts): error answers
// with `upgrade: true` (a limit of the person's own account, while the
// instance offers an upgrade) are remembered by their message, so the
// error toast can offer "Upgrade" next to it (components/workspace-app.tsx).
const offered = new Set<string>();
export const UPGRADE_PATH = "/api/upgrade";
export function rememberUpgrade(message: string, data: unknown) {
  if (!data || typeof data !== "object" || (data as { upgrade?: unknown }).upgrade !== true) return;
  offered.add(message);
  if (offered.size > 20) offered.delete(offered.values().next().value!);
}
export const upgradeOffered = (...texts: (string | undefined)[]) => texts.some((t) => !!t && offered.has(t));
export function openUpgrade() {
  window.open(UPGRADE_PATH, "_blank", "noopener");
}
