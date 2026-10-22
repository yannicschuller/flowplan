"use client";
// What every section of the (user) settings needs: the bootstrap, saving,
// errors and – for workspace owners – the workspace's invitations, groups,
// grants and SSO mappings (/api/settings), loaded once for all sections.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ThemeChoice } from "@/lib/theme";
import type { Bootstrap } from "@/lib/types";
import { api } from "../ui";
import type { SsoMappingRow } from "../sso-mappings";

export type WorkspaceSettingsData = {
  invites: { id: string; email: string; role: string; guest?: number; created_at?: number | null; inviter?: string | null; pages?: string[]; token?: string }[];
  groups: { id: string; name: string }[];
  groupMembers: { group_id: string; user_id: string }[];
  grants: { resource_id: string; user_id: string; group_id: string; role: string }[];
  // SSO groups mapped to membership and groups (lib/sso-mappings.ts).
  sso?: boolean;
  ssoMappings?: SsoMappingRow[];
  ssoSources?: { user_id: string; target: string; sso_group: string }[];
};

export type UserSettingsProps = {
  boot: Bootstrap;
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onError: (s: string) => void;
  onRefresh: () => Promise<unknown>;
  onWorkspaceExit: (id: string | null) => Promise<unknown> | void;
  theme: ThemeChoice;
  setTheme: (choice: ThemeChoice) => void;
};

type Ctx = UserSettingsProps & {
  owner: boolean;
  // /api/settings of the workspace; null until loaded and for non-owners.
  workspace: WorkspaceSettingsData | null;
  reload: () => Promise<void>;
  // A workspace command, then a reload; false when it failed (the error is
  // shown already).
  act: (body: Record<string, unknown>) => Promise<boolean>;
};

const UserSettingsContext = createContext<Ctx | null>(null);

export function UserSettingsProvider({ children, ...props }: UserSettingsProps & { children: ReactNode }) {
  const { boot, mutate, onError } = props;
  const owner = boot.workspace.role === "owner";
  const [workspace, setWorkspace] = useState<WorkspaceSettingsData | null>(null);
  const reload = useCallback(async () => {
    if (owner) setWorkspace(await api(`/api/settings?workspace=${boot.workspace.id}`));
  }, [owner, boot.workspace.id]);
  // The callbacks of the app may change identity on every render.
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    void reload().catch((e) => errorRef.current((e as Error).message));
  }, [reload]);
  const act = useCallback(
    async (b: Record<string, unknown>) => {
      try {
        await mutate({ workspaceId: boot.workspace.id, ...b });
        await reload();
        return true;
      } catch (e) {
        onError((e as Error).message);
        return false;
      }
    },
    [mutate, boot.workspace.id, reload, onError],
  );
  return <UserSettingsContext.Provider value={{ ...props, owner, workspace, reload, act }}>{children}</UserSettingsContext.Provider>;
}

export function useUserSettings() {
  const ctx = useContext(UserSettingsContext);
  if (!ctx) throw new Error("useUserSettings outside UserSettingsProvider");
  return ctx;
}
