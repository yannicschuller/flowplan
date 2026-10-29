"use client";
// What the sections of the administration share: /api/admin (loaded when a
// section that needs it opens; the previous answer shows meanwhile),
// commands with a reload, and errors.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { BuildInfo } from "@/lib/build-info";
import type { UpdateStatus } from "@/lib/update-check";
import type { User } from "@/lib/types";
import type { InstanceSettings } from "@/lib/instance-settings";
import type { MarkdownExportStatus, SpaceGitOverview } from "../markdown-export-settings";
import type { EncryptionStatus } from "../encryption-settings";
import type { SsoMappingRow } from "../sso-mappings";
import { api } from "../ui";

export type AdminData = {
  users: User[];
  // pages without journal days; days counted apart (#49).
  workspaces: { id: string; name: string; members: number; pages: number; days?: number; owners: { id: string; name: string; email: string | null }[] }[];
  sessions: number;
  audit: { id: string; name: string; action: string; resource_id: string; created_at: string }[];
  adminGroup: string;
  build?: BuildInfo;
  // A newer release than the running one (lib/update-check.ts).
  update?: UpdateStatus | null;
  userUsage?: {
    id: string;
    bytes: number;
    workspaces: number;
    limits: { storageMb?: number | null; workspaces?: number | null; uploadMb?: number | null };
    effective: { storageMb: number; workspaces: number; uploadMb: number };
  }[];
  oidcConfigured: boolean;
  // SSO groups mapped to workspaces (lib/sso-mappings.ts).
  ssoMappings?: SsoMappingRow[];
  workspaceGroups?: { id: string; workspace_id: string; name: string }[];
  metrics: {
    databaseBytes: number;
    uploadBytes: number;
    files: number;
    pages: number;
    trashedPages: number;
    journalDays?: number;
    rows: number;
    snapshots: number;
    pushPending: number;
    pushFailed: number;
    searchBacklog: number;
    reminders: number;
    demosActive: number;
    demosStarted: number;
    retentionDays: number;
    defaultQuotaMb: number;
    uptimeSeconds: number;
    node: string;
  };
  usage: { id: string; bytes: number; quotaMb: number | null; effectiveQuotaMb: number }[];
  settings: InstanceSettings;
  localLogin?: boolean;
  localAccounts?: Record<string, { admin: boolean; verified: boolean; passkeys: number; totp?: boolean }>;
  // Administrators of every kind of sign-in (lib/auth.ts adminUserIds).
  adminIds?: string[];
  mail: { configured: boolean; host: string | null; from: string | null; pending: number; failed: number; sentWeek: number; lastError: string | null };
  markdownExport: MarkdownExportStatus;
  spaceGitExport: SpaceGitOverview;
  encryption: EncryptionStatus;
  backup: {
    enabled: boolean;
    hourly: boolean;
    encrypted: boolean;
    keep: number;
    target: "s3" | "local";
    last: { at: number; target: string; name: string; bytes: number; error: string | null } | null;
  };
  // Who may use AI when only selected people may (lib/ai/settings.ts).
  aiPolicy?: { access: "everyone" | "selected"; enabled: boolean; allowed: string[] };
  restorePending: { createdAt: string; users: number; workspaces: number; pages: number; files: number } | null;
};

export type AdminProps = {
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onError: (s: string) => void;
};

type Ctx = AdminProps & {
  data: AdminData | null;
  // Loads /api/admin again (after a change, or the refresh button).
  load: () => Promise<void>;
  // A command, then a reload; the command's result, undefined when it failed.
  act: (body: Record<string, unknown>) => Promise<unknown>;
  // Sections that need /api/admin call this when they open (useAdminData does).
  ensure: () => void;
};

const AdminContext = createContext<Ctx | null>(null);

export function AdminProvider({ children, mutate, onError }: AdminProps & { children: ReactNode }) {
  const [data, setData] = useState<AdminData | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const load = useCallback(async () => {
    try {
      setData(await api("/api/admin"));
    } catch (e) {
      errorRef.current((e as Error).message);
    }
  }, []);
  // A section that opens shows what was loaded before and fetches anew
  // (changes made in another section or by another admin).
  const ensure = useCallback(() => void load(), [load]);
  const act = useCallback(
    async (b: Record<string, unknown>) => {
      try {
        const result = await mutate(b);
        await load();
        return result;
      } catch (e) {
        errorRef.current((e as Error).message);
      }
    },
    [mutate, load],
  );
  return <AdminContext.Provider value={{ mutate, onError, data, load, act, ensure }}>{children}</AdminContext.Provider>;
}

export function useAdmin() {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin outside AdminProvider");
  return ctx;
}

// /api/admin for a section: null while it loads (show <AdminLoading/>).
export function useAdminData() {
  const ctx = useAdmin();
  const { ensure } = ctx;
  useEffect(() => ensure(), [ensure]);
  return ctx;
}
