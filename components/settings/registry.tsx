"use client";
// The sections of lib/settings-sections.ts with their icon and the component
// that renders them. A new section: its metadata there, its component here
// (one file per section in ./user or ./admin). docs/settings-architecture.md
import type { ComponentType } from "react";
import {
  BellSimple,
  BookmarkSimple,
  CalendarBlank,
  Database,
  DeviceMobile,
  EnvelopeSimple,
  FileArrowDown,
  FolderSimple,
  Gauge,
  HardDrives,
  Key,
  ListChecks,
  LockKey,
  Megaphone,
  Palette,
  PlugsConnected,
  Pulse,
  PuzzlePiece,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Stack,
  Timer,
  UserCircle,
  Users,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SectionMeta, type SettingsArea } from "@/lib/settings-sections";
import AccountSection from "./user/account";
import AppearanceSection from "./user/appearance";
import NotificationsSection from "./user/notifications";
import AiSection from "./user/ai";
import DevicesSection from "./user/devices";
import ApiSection from "./user/api";
import ConnectionsSection from "./user/connections";
import ClipperSection from "./user/clipper";
import WorkspaceSection from "./user/workspace";
import MembersSection from "./user/members";
import GroupsSection from "./user/groups";
import SpacesSection from "./user/spaces";
import ExtensionsSection from "./user/extensions";
import DataSection from "./user/data";
import TimeSection from "./user/time";
import UsersSection from "./admin/users";
import SigninSection from "./admin/signin";
import WorkspacesSection from "./admin/workspaces";
import StorageSection from "./admin/storage";
import ExportSection from "./admin/export";
import MailSection from "./admin/mail";
import AdminAiSection from "./admin/ai";
import SecuritySection from "./admin/security";
import AuditSection from "./admin/audit";
import MonitoringSection from "./admin/monitoring";
import GeneralSection from "./admin/general";
import LimitsSection from "./admin/limits";
import AdminExtensionsSection from "./admin/extensions";
import MaintenanceSection from "./admin/maintenance";

export const ICONS: Record<string, Icon> = {
  BellSimple,
  BookmarkSimple,
  CalendarBlank,
  Database,
  DeviceMobile,
  EnvelopeSimple,
  FileArrowDown,
  FolderSimple,
  Gauge,
  HardDrives,
  Key,
  ListChecks,
  LockKey,
  Megaphone,
  Palette,
  PlugsConnected,
  Pulse,
  PuzzlePiece,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Stack,
  Timer,
  UserCircle,
  Users,
  UsersThree,
};

const USER_COMPONENTS: Record<string, ComponentType> = {
  account: AccountSection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  ai: AiSection,
  devices: DevicesSection,
  api: ApiSection,
  connections: ConnectionsSection,
  clipper: ClipperSection,
  workspace: WorkspaceSection,
  members: MembersSection,
  groups: GroupsSection,
  spaces: SpacesSection,
  extensions: ExtensionsSection,
  data: DataSection,
  time: TimeSection,
};

const ADMIN_COMPONENTS: Record<string, ComponentType> = {
  users: UsersSection,
  signin: SigninSection,
  workspaces: WorkspacesSection,
  storage: StorageSection,
  export: ExportSection,
  mail: MailSection,
  ai: AdminAiSection,
  security: SecuritySection,
  audit: AuditSection,
  monitoring: MonitoringSection,
  general: GeneralSection,
  limits: LimitsSection,
  extensions: AdminExtensionsSection,
  maintenance: MaintenanceSection,
};

export type SectionDef = SectionMeta & { Icon: Icon; Component: ComponentType };

export function sectionDefs(area: SettingsArea): SectionDef[] {
  const components = area === "admin" ? ADMIN_COMPONENTS : USER_COMPONENTS;
  return SETTINGS_SECTIONS.filter((s) => s.area === area && components[s.id]).map((s) => ({ ...s, Icon: ICONS[s.icon] ?? SlidersHorizontal, Component: components[s.id] }));
}
export const groupsOf = (area: SettingsArea) => SETTINGS_GROUPS.filter((g) => g.area === area);
