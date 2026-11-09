"use client";
import { useEffect, useState } from "react";
import { GitCommit, GitPullRequest, GitMerge } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { StatusBadge, type Tone } from "./settings-ui";
import { api } from "./ui";

type Link = { id: string; kind: string; ref: string; title: string; url: string; author: string; state: string; at: number };

// Commits and pull requests that mention the record (Git connection).
export function RecordGit({ pageId, rowId }: { pageId: string; rowId: string }) {
  const t = useT();
  const [links, setLinks] = useState<Link[]>([]);
  useEffect(() => {
    void api<Link[]>(`/api/git-links?page=${pageId}&row=${rowId}`)
      .then(setLinks)
      .catch(() => setLinks([]));
  }, [pageId, rowId]);
  // The state of a pull/merge request as a badge (GitHub/Gitea: open,
  // closed; GitLab: opened, closed, locked; all: merged).
  const prState = (state: string): [Tone, string] =>
    state === "merged"
      ? ["info", t("Zusammengeführt", "Merged")]
      : state === "open" || state === "opened"
        ? ["ok", t("Offen", "Open||status")]
        : state === "closed"
          ? ["off", t("Geschlossen", "Closed||pull request")]
          : ["off", state];
  if (!links.length) return null;
  return (
    <section className="settings-section record-git" aria-label={t("Entwicklung", "Development")}>
      <h3>{t("Entwicklung", "Development")}</h3>
      <ul>
        {links.map((l) => {
          const Icon = l.kind === "commit" ? GitCommit : l.state === "merged" ? GitMerge : GitPullRequest;
          return (
            <li key={l.id} data-state={l.state}>
              <Icon aria-hidden />
              <a href={l.url} target="_blank" rel="noreferrer">
                {l.title || l.ref}
              </a>
              <span className="muted">
                {l.kind === "pr" && l.state && (
                  <>
                    <StatusBadge tone={prState(l.state)[0]}>{prState(l.state)[1]}</StatusBadge>{" "}
                  </>
                )}
                {l.kind === "commit" ? l.ref.slice(0, 7) : `#${l.ref}`}
                {l.author ? ` · ${l.author}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
