"use client";
// The sections of lib/settings-sections.ts with their icon and the component
// that renders them. A new section: its metadata there, its component here
// (one file per section in ./user or ./admin). docs/settings-architecture.md
import type { ComponentType } from "react";
import {
  BellRinging,
  BellSimple,
  BookmarkSimple,
  CalendarBlank,
  ChatCircleDots,
  Database,
  DeviceMobile,
  EnvelopeSimple,
  FileArrowDown,
  FolderSimple,
  Gauge,
  HardDrives,
  Info,
  Key,
  ListChecks,
  LinkSimple,
  LockKey,
  Megaphone,
  Microphone,
  PaintBrush,
  Palette,
  PlugsConnected,
  Printer,
  Pulse,
  PuzzlePiece,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Stack,
  Tag,
  Timer,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
  type Icon,
} from "@phosphor-icons/react";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SectionMeta, type SettingsArea } from "@/lib/settings-sections";
import dynamic from "next/dynamic";
import { loadView } from "../view-fallback";
import { AdminLoading } from "./shell";

// Each section loads with its page (next/dynamic): the workspace bundle
// carries none of them, the landing page only the tiles. The outline
// (AdminLoading) stands in while a section loads.
const Loading = () => <AdminLoading />;
const AccountSection = dynamic(() => loadView(() => import("./user/account")), { ssr: false, loading: Loading });
const MySecuritySection = dynamic(() => loadView(() => import("./user/security")), { ssr: false, loading: Loading });
const AppearanceSection = dynamic(() => loadView(() => import("./user/appearance")), { ssr: false, loading: Loading });
const NotificationsSection = dynamic(() => loadView(() => import("./user/notifications")), { ssr: false, loading: Loading });
const AiSection = dynamic(() => loadView(() => import("./user/ai")), { ssr: false, loading: Loading });
const DevicesSection = dynamic(() => loadView(() => import("./user/devices")), { ssr: false, loading: Loading });
const ApiSection = dynamic(() => loadView(() => import("./user/api")), { ssr: false, loading: Loading });
const WebhooksSection = dynamic(() => loadView(() => import("./user/webhooks")), { ssr: false, loading: Loading });
const ConnectionsSection = dynamic(() => loadView(() => import("./user/connections")), { ssr: false, loading: Loading });
const ClipperSection = dynamic(() => loadView(() => import("./user/clipper")), { ssr: false, loading: Loading });
const WorkspaceSection = dynamic(() => loadView(() => import("./user/workspace")), { ssr: false, loading: Loading });
const WorkspaceLookSection = dynamic(() => loadView(() => import("./user/workspace-look")), { ssr: false, loading: Loading });
const LinkRulesSection = dynamic(() => loadView(() => import("./user/link-rules")), { ssr: false, loading: Loading });
const PrintSection = dynamic(() => loadView(() => import("./user/print").then((m) => ({ default: m.PrintSection }))), { ssr: false, loading: Loading });
const WorkspacePrintSection = dynamic(() => loadView(() => import("./user/print").then((m) => ({ default: m.WorkspacePrintSection }))), { ssr: false, loading: Loading });
const MembersSection = dynamic(() => loadView(() => import("./user/members")), { ssr: false, loading: Loading });
const GroupsSection = dynamic(() => loadView(() => import("./user/groups")), { ssr: false, loading: Loading });
const SpacesSection = dynamic(() => loadView(() => import("./user/spaces")), { ssr: false, loading: Loading });
const TagsSection = dynamic(() => loadView(() => import("./user/tags")), { ssr: false, loading: Loading });
const ExtensionsSection = dynamic(() => loadView(() => import("./user/extensions")), { ssr: false, loading: Loading });
const DataSection = dynamic(() => loadView(() => import("./user/data")), { ssr: false, loading: Loading });
const TimeSection = dynamic(() => loadView(() => import("./user/time")), { ssr: false, loading: Loading });
const MeetingsSection = dynamic(() => loadView(() => import("./user/meetings")), { ssr: false, loading: Loading });
const AboutSection = dynamic(() => loadView(() => import("./user/about")), { ssr: false, loading: Loading });
const UsersSection = dynamic(() => loadView(() => import("./admin/users")), { ssr: false, loading: Loading });
const SigninSection = dynamic(() => loadView(() => import("./admin/signin")), { ssr: false, loading: Loading });
const WorkspacesSection = dynamic(() => loadView(() => import("./admin/workspaces")), { ssr: false, loading: Loading });
const StorageSection = dynamic(() => loadView(() => import("./admin/storage")), { ssr: false, loading: Loading });
const ExportSection = dynamic(() => loadView(() => import("./admin/export")), { ssr: false, loading: Loading });
const MailSection = dynamic(() => loadView(() => import("./admin/mail")), { ssr: false, loading: Loading });
const PushSection = dynamic(() => loadView(() => import("./admin/push")), { ssr: false, loading: Loading });
const MessengersSection = dynamic(() => loadView(() => import("./admin/messengers")), { ssr: false, loading: Loading });
const AdminAiSection = dynamic(() => loadView(() => import("./admin/ai")), { ssr: false, loading: Loading });
const SecuritySection = dynamic(() => loadView(() => import("./admin/security")), { ssr: false, loading: Loading });
const SecurityCenterSection = dynamic(() => loadView(() => import("./admin/security-center")), { ssr: false, loading: Loading });
const AuditSection = dynamic(() => loadView(() => import("./admin/audit")), { ssr: false, loading: Loading });
const MonitoringSection = dynamic(() => loadView(() => import("./admin/monitoring")), { ssr: false, loading: Loading });
const GeneralSection = dynamic(() => loadView(() => import("./admin/general")), { ssr: false, loading: Loading });
const LimitsSection = dynamic(() => loadView(() => import("./admin/limits")), { ssr: false, loading: Loading });
const AdminExtensionsSection = dynamic(() => loadView(() => import("./admin/extensions")), { ssr: false, loading: Loading });
const MaintenanceSection = dynamic(() => loadView(() => import("./admin/maintenance")), { ssr: false, loading: Loading });

export const ICONS: Record<string, Icon> = {
  BellRinging,
  BellSimple,
  BookmarkSimple,
  CalendarBlank,
  ChatCircleDots,
  Database,
  DeviceMobile,
  EnvelopeSimple,
  FileArrowDown,
  FolderSimple,
  Gauge,
  HardDrives,
  Info,
  Key,
  ListChecks,
  LinkSimple,
  LockKey,
  Megaphone,
  Microphone,
  PaintBrush,
  Palette,
  PlugsConnected,
  Printer,
  Pulse,
  PuzzlePiece,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Stack,
  Tag,
  Timer,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
};

const USER_COMPONENTS: Record<string, ComponentType> = {
  account: AccountSection,
  security: MySecuritySection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  ai: AiSection,
  devices: DevicesSection,
  api: ApiSection,
  webhooks: WebhooksSection,
  connections: ConnectionsSection,
  clipper: ClipperSection,
  workspace: WorkspaceSection,
  look: WorkspaceLookSection,
  autolinks: LinkRulesSection,
  print: PrintSection,
  printpresets: WorkspacePrintSection,
  members: MembersSection,
  groups: GroupsSection,
  spaces: SpacesSection,
  tags: TagsSection,
  extensions: ExtensionsSection,
  data: DataSection,
  time: TimeSection,
  meetings: MeetingsSection,
  about: AboutSection,
};

const ADMIN_COMPONENTS: Record<string, ComponentType> = {
  users: UsersSection,
  signin: SigninSection,
  workspaces: WorkspacesSection,
  storage: StorageSection,
  export: ExportSection,
  mail: MailSection,
  push: PushSection,
  messengers: MessengersSection,
  ai: AdminAiSection,
  security: SecuritySection,
  threats: SecurityCenterSection,
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
