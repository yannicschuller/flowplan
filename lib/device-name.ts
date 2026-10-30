// The device of a session or a sign-in from its user agent: the Flowplan
// app, the browser and the system (lib/my-sessions.ts, lib/security-events.ts).
export function deviceName(agent: string) {
  const app = /FlowplanMobile\//.test(agent) ? "Flowplan app" : /FlowplanDesktop\/|Electron\//.test(agent) ? "Flowplan desktop" : "";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "";
  const system = /iPad/.test(agent)
    ? "iPad"
    : /iPhone/.test(agent)
      ? "iPhone"
      : /Android/.test(agent)
        ? "Android"
        : /Mac OS X|Macintosh/.test(agent)
          ? "macOS"
          : /Windows/.test(agent)
            ? "Windows"
            : /Linux/.test(agent)
              ? "Linux"
              : "";
  return { app, browser, system };
}

// One line: "Chrome · macOS", "Flowplan app · iPhone".
export function deviceLabel(agent: string) {
  const d = deviceName(agent);
  return [d.app || d.browser, d.system].filter(Boolean).join(" · ");
}
