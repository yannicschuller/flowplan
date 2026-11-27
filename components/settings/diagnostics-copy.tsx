"use client";
// "Für Bug-Report kopieren" (#630): the installation details in one line –
// the backend part from the server (lib/diagnostics.ts, the instance details
// only for administrators), the frontend part read here in the browser
// (lib/diagnostics-text.ts) – shown read-only and copied with one click.
// Settings → Über Flowplan passes the backend part from the boot data;
// without it (Administration → Name & Version) it is fetched once.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { clientDiagnostics, currentClientHints, diagnosticsText, type BackendDiagnostics } from "@/lib/diagnostics-text";
import { useT } from "../i18n";
import { SettingRow } from "../settings-ui";

const noSubscribe = () => () => {};
let clientCache: ReturnType<typeof clientDiagnostics> | null = null;
const readClient = () => (clientCache ??= clientDiagnostics(currentClientHints()));

export function DiagnosticsCopy({ backend, anchor }: { backend?: BackendDiagnostics | null; anchor?: string }) {
  const t = useT();
  const [fetched, setFetched] = useState<BackendDiagnostics | null>(null);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const box = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const client = useSyncExternalStore(noSubscribe, readClient, () => null);
  const data = backend ?? fetched;
  useEffect(() => {
    if (backend) return;
    let gone = false;
    fetch("/api/diagnostics", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<BackendDiagnostics>) : null))
      .then((d) => !gone && d && setFetched(d))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [backend]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const text = data && client ? diagnosticsText(data, client) : "";
  const later = (next: "idle") => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(next), 2400);
  };
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      later("idle");
    } catch {
      // No clipboard (an old web view, a denied permission): the text is
      // selected, so ⌘C / Ctrl+C or the system's menu copies it.
      const node = box.current;
      const selection = typeof window === "undefined" ? null : window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setState("failed");
    }
  };
  return (
    <SettingRow
      anchor={anchor}
      wide
      label={t("Für Bug-Report kopieren", "Copy for bug report")}
      description={
        data?.scope === "admin"
          ? t(
              "Version, Build, Node.js, Installationsart, Datenbank, Speicher und Betriebsart dieser Instanz und dein Gerät – zum Einfügen in einen Bug-Report. Ohne Namen, Adressen oder Hosts.",
              "Version, build, Node.js, install method, database, storage and mode of this instance, and your device – to paste into a bug report. No names, addresses or hosts.",
            )
          : t(
              "Version und Build dieser Instanz und dein Gerät – zum Einfügen in einen Bug-Report. Ohne Namen, Adressen oder Hosts.",
              "Version and build of this instance, and your device – to paste into a bug report. No names, addresses or hosts.",
            )
      }
    >
      <div className="about-diagnostics">
        <code ref={box} className="about-diagnostics-text" data-testid="diagnostics-text" aria-label={t("Installationsdetails", "Installation details")}>
          {text || t("Wird geladen …", "Loading …")}
        </code>
        <div className="about-diagnostics-actions">
          <button type="button" className="button" onClick={() => void copy()} disabled={!text}>
            {state === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {state === "copied" ? t("Kopiert", "Copied") : t("Für Bug-Report kopieren", "Copy for bug report")}
          </button>
          <span role="status" className="about-diagnostics-status">
            {state === "copied"
              ? t("In die Zwischenablage kopiert.", "Copied to the clipboard.")
              : state === "failed"
                ? t("Kopieren ging nicht – der Text ist markiert, kopiere ihn selbst.", "Copying did not work – the text is selected, copy it yourself.")
                : ""}
          </span>
        </div>
      </div>
    </SettingRow>
  );
}
