"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState } from "react";
import { api } from "./ui";
import type { Bootstrap } from "@/lib/types";

// Lets signed-in visitors copy a publication into one of their workspaces.
export function PublicationCopy({ token }: { token: string }) {
  const t = useT();
  const [open, setOpen] = useState(false),
    [boot, setBoot] = useState<Bootstrap | null>(null),
    [signedOut, setSignedOut] = useState(false),
    [workspace, setWorkspace] = useState(""),
    [space, setSpace] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load(workspaceId?: string) {
    setError("");
    const response = await fetch(
      `/api/bootstrap${workspaceId ? `?workspace=${workspaceId}` : ""}`,
    );
    if (response.status === 401) {
      setSignedOut(true);
      return;
    }
    if (!response.ok) {
      setError(t("Arbeitsbereiche konnten nicht geladen werden.", "Workspaces could not be loaded."));
      return;
    }
    const next = (await response.json()) as Bootstrap;
    setBoot(next);
    setWorkspace(next.workspace.id);
    setSpace(
      next.spaces.find((s) => s.visibility === "private")?.id ||
        next.spaces[0]?.id ||
        "",
    );
  }
  return (
    <div className="publication-copy">
      {!open ? (
        <button
          className="button"
          onClick={() => {
            setOpen(true);
            void load();
          }}
        >
          {t("In meinen Arbeitsbereich kopieren", "Copy to my workspace")}
        </button>
      ) : signedOut ? (
        <a
          className="button primary"
          href={`/api/auth/login?returnTo=${encodeURIComponent(`/share/${token}`)}`}
        >
          {t("Anmelden, um zu kopieren", "Sign in to copy")}
        </a>
      ) : boot ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const result = await api<{ id: string }>("/api/command", {
                action: "publication.copy",
                token,
                workspaceId: workspace,
                spaceId: space,
              });
              location.href = `/#page=${result.id}`;
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Arbeitsbereich", "Workspace")}
            <Select
              value={workspace}
              disabled={busy}
              onChange={(e) => void load(e.target.value)}
            >
              {boot.workspaces
                .filter((w) => w.role !== "viewer")
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </Select>
          </label>
          <label>
            {t("Bereich", "Space")}
            <Select
              value={space}
              disabled={busy}
              onChange={(e) => setSpace(e.target.value)}
            >
              {boot.spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
          <button className="button primary" disabled={busy || !space}>
            {busy ? t("Wird kopiert …", "Copying …") : t("Kopie anlegen", "Create copy")}
          </button>
          <p className="muted">
            {t("Kopiert werden die veröffentlichten Seiten, sichtbare Eigenschaften und veröffentlichte Dateien. Kommentare, Versionen und Freigaben bleiben beim Original.", "The published pages, visible properties and published files are copied. Comments, versions and shares stay with the original.")}
          </p>
        </form>
      ) : (
        !error && <p className="muted">{t("Arbeitsbereiche werden geladen …", "Loading workspaces …")}</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
