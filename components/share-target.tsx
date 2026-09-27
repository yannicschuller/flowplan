"use client";
import { useEffect, useState } from "react";
import { BrandMark } from "./brand-mark";
import { Select } from "./select";
import { api } from "./ui";

type Boot = {
  workspace: { id: string; name: string };
  workspaces: { id: string; name: string; role: string; guest?: number }[];
  spaces: { id: string; name: string; deleted_at?: string | null }[];
};

// Preview of shared text or link with a choice where it goes.
export function ShareTarget({ title, text, url }: { title: string; text: string; url: string }) {
  const [boot, setBoot] = useState<Boot | null>(null),
    [workspace, setWorkspace] = useState(""),
    [space, setSpace] = useState(""),
    [name, setName] = useState(title),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const query = workspace ? `?workspace=${workspace}` : "";
    void api<Boot>(`/api/bootstrap${query}`)
      .then((b) => {
        setBoot(b);
        setWorkspace(b.workspace.id);
        setSpace(b.spaces.find((s) => !s.deleted_at)?.id || "");
      })
      .catch((e) => setError((e as Error).message));
  }, [workspace]);
  const writable = boot?.workspaces.filter((w) => !w.guest && w.role !== "viewer") || [];
  const nothing = !title && !text && !url;
  return (
    <main className="share-target">
      <header>
        <BrandMark size={28} />
        <h1>In Flowplan speichern</h1>
      </header>
      {nothing ? (
        <p className="muted">Es wurde nichts geteilt. Teile einen Text oder Link aus einer anderen App an Flowplan.</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const r = await api<{ id: string }>("/api/command", {
                action: "page.fromShare",
                workspaceId: workspace,
                spaceId: space,
                title: name,
                text,
                url,
              });
              location.replace(`/#page=${r.id}`);
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          <label>
            Titel
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Wird aus dem Inhalt gebildet" maxLength={200} />
          </label>
          <div className="share-target-preview" aria-label="Geteilter Inhalt">
            {text && <p>{text}</p>}
            {url && <p className="share-target-link">{url}</p>}
          </div>
          {writable.length > 1 && (
            <label>
              Arbeitsbereich
              <Select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                {writable.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label>
            Bereich
            <Select value={space} onChange={(e) => setSpace(e.target.value)} disabled={!boot}>
              {(boot?.spaces || [])
                .filter((s) => !s.deleted_at)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          </label>
          <div className="share-target-actions">
            <button className="button primary" disabled={busy || !space}>
              {busy ? "Wird gespeichert …" : "Als Seite speichern"}
            </button>
            <a className="button" href="/">
              Abbrechen
            </a>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
