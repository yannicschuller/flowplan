"use client";
import { useT } from "./i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useEffect, useState } from "react";
import { BrandMark } from "./brand-mark";
import { Select } from "./select";
import { api } from "./ui";
import { CaptureTargetPicker, rememberCaptureTarget, useCaptureTargets } from "./capture-target";

type Boot = {
  workspace: { id: string; name: string };
  workspaces: { id: string; name: string; role: string; guest?: number }[];
  spaces: { id: string; name: string; deleted_at?: string | null }[];
};

// Preview of shared text or link with a choice where it goes.
export function ShareTarget({ title, text, url }: { title: string; text: string; url: string }) {
  const t = useT();
  const [boot, setBoot] = useState<Boot | null>(null),
    [workspace, setWorkspace] = useState(""),
    [space, setSpace] = useState(""),
    [name, setName] = useState(title),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [as, setAs] = useState<"page" | "bookmark" | "record">("page"),
    [modeChosen, setModeChosen] = useState(false),
    [database, setDatabase] = useState(""),
    [makeDefault, setMakeDefault] = useState(false),
    [withArticle, setWithArticle] = useState(false),
    [article, setArticle] = useState<{ html: string; words: number; title: string } | null>(null),
    [clipping, setClipping] = useState(false);
  const link = url || text.match(/https?:\/\/\S+/)?.[0] || "";
  async function loadArticle(on: boolean) {
    setWithArticle(on);
    if (!on || article || !link) return;
    setClipping(true);
    setError("");
    try {
      const clip = await api<{ html: string; words: number; title: string }>("/api/clip", { url: link });
      setArticle(clip);
      if (!name.trim() && clip.title) setName(clip.title);
    } catch (e) {
      setError((e as Error).message);
      setWithArticle(false);
    } finally {
      setClipping(false);
    }
  }
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
  const [targets] = useCaptureTargets(workspace);
  // A default capture database makes "As a record" the first choice.
  useEffect(() => {
    if (!targets) return;
    setDatabase(targets.default || targets.databases[0]?.id || "");
    setMakeDefault(false);
    if (!modeChosen) setAs(targets.default ? "record" : "page");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets]);
  const choose = (mode: "page" | "bookmark" | "record") => {
    setAs(mode);
    setModeChosen(true);
  };
  const writable = boot?.workspaces.filter((w) => !w.guest && w.role !== "viewer") || [];
  const nothing = !title && !text && !url;
  return (
    <main className="share-target">
      <header>
        <BrandMark size={28} />
        <h1>{t("In Flowplan speichern", "Save to Flowplan")}</h1>
      </header>
      {nothing ? (
        <p className="muted">{t("Es wurde nichts geteilt. Teile einen Text oder Link aus einer anderen App an Flowplan.", "Nothing was shared. Share a text or link from another app to Flowplan.")}</p>
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
                url: link,
                as,
                ...(as === "record" ? { databaseId: database } : {}),
                ...(withArticle && article ? { article: article.html } : {}),
              });
              if (as === "record" && makeDefault) await rememberCaptureTarget(workspace, database, targets).catch(() => undefined);
              const target = r as { id: string; rowId?: string };
              // Opened from the bookmarklet: close the small window again.
              if (window.opener && window.name === "flowplan") {
                window.close();
                return;
              }
              location.replace(`/#page=${target.id}${target.rowId ? `&row=${target.rowId}` : ""}`);
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Titel", "Title")}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Wird aus dem Inhalt gebildet", "Taken from the content")} maxLength={200} />
          </label>
          <div className="share-target-mode" role="radiogroup" aria-label={t("Speichern als", "Save as")}>
            <button type="button" role="radio" aria-checked={as === "page"} className={`chip${as === "page" ? " active" : ""}`} onClick={() => choose("page")}>
              {t("Als Seite", "As a page")}
            </button>
            {(targets?.databases.length || 0) > 0 && (
              <button type="button" role="radio" aria-checked={as === "record"} className={`chip${as === "record" ? " active" : ""}`} onClick={() => choose("record")}>
                {t("Als Eintrag", "As a record")}
              </button>
            )}
            {link && (
              <button type="button" role="radio" aria-checked={as === "bookmark"} className={`chip${as === "bookmark" ? " active" : ""}`} onClick={() => choose("bookmark")}>
                {t("Als Lesezeichen", "As a bookmark")}
              </button>
            )}
          </div>
          {link && (
            <label className="share-target-article">
              <input type="checkbox" checked={withArticle} disabled={clipping} onChange={(e) => void loadArticle(e.target.checked)} />
              {t("Artikeltext übernehmen", "Include article text")}
              {clipping && <small> {t("wird geladen …", "loading …")}</small>}
              {withArticle && article && <small> {article.words.toLocaleString(LOCALE_TAG)} {t("Wörter", "words")}</small>}
            </label>
          )}
          <div className="share-target-preview" aria-label={t("Geteilter Inhalt", "Shared content")}>
            {text && <p>{text}</p>}
            {url && <p className="share-target-link">{url}</p>}
          </div>
          {writable.length > 1 && (
            <label>
              {t("Arbeitsbereich", "Workspace")}
              <Select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                {writable.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {as === "record" ? (
            <CaptureTargetPicker targets={targets} value={database} onChange={setDatabase} makeDefault={makeDefault} onMakeDefault={setMakeDefault} />
          ) : (
          <label>
            {t("Bereich", "Space")}
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
          )}
          <div className="share-target-actions">
            <button className="button primary" disabled={busy || !space || (as === "record" && !database)}>
              {busy
                ? t("Wird gespeichert …", "Saving …")
                : as === "bookmark"
                  ? t("Als Lesezeichen speichern", "Save as bookmark")
                  : as === "record"
                    ? t("Als Eintrag speichern", "Save as record")
                    : t("Als Seite speichern", "Save as page")}
            </button>
            <a className="button" href="/">
              {t("Abbrechen", "Cancel")}
            </a>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
