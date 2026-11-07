"use client";
import { GitFork, GithubLogo, GitlabLogo } from "@phosphor-icons/react";
import type { IssueProvider } from "@/lib/issue-sync";

export type { IssueProvider };

// The providers of the issue sync (lib/issue-sync.ts) as the settings and
// the database dialog name them. Forgejo and Gitea share one API.
export const ISSUE_PROVIDER_NAMES: Record<IssueProvider, string> = { github: "GitHub", gitlab: "GitLab", forgejo: "Forgejo / Gitea" };

export function IssueProviderLogo({ provider }: { provider: IssueProvider }) {
  if (provider === "github") return <GithubLogo aria-hidden />;
  if (provider === "gitlab") return <GitlabLogo aria-hidden />;
  return <GitFork aria-hidden />;
}
