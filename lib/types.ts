export type Role = "owner" | "editor" | "viewer";
export type PageKind = "document" | "database" | "whiteboard" | "journal";
export type User = {
  id: string;
  name: string;
  email: string;
  disabled: number;
  created_at: string;
  // Version of the stored profile picture, null without one.
  avatar?: string | null;
  // Public demo accounts: end at the latest (ms), null for real accounts.
  demo_until?: number | null;
  // Last sign-in through the identity provider (ms).
  last_login_at?: number | null;
};
export type Identity = User & {
  groups: string[];
  isAdmin: boolean;
  demo?: boolean;
  // Set when the request came with a personal API token.
  apiScope?: "read" | "write";
};
export type Workspace = {
  id: string;
  name: string;
  icon: string;
  role: Role;
  // 1 when the person only sees pages shared with them.
  guest?: number;
};
export type Space = {
  icon_color?: string;
  id: string;
  workspace_id: string;
  name: string;
  icon: string;
  visibility: "team" | "private";
  owner_id: string;
  deleted_at?: string | null;
  version?: number;
};
export type Page = {
  id: string;
  workspace_id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  icon: string;
  cover: string;
  cover_position?: number;
  kind: PageKind;
  position: number;
  deleted_at: string | null;
  created_by: string;
  updated_at: string;
  locked: number;
  public_token: string | null;
  full_width: number;
  icon_size?: "" | "small" | "medium" | "large";
  font: string;
  // Day pages of a journal: the day they belong to (YYYY-MM-DD).
  journal_date?: string | null;
  // 1 for the content of a synced block (not listed in the page tree).
  synced?: number;
};
export type FieldType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "multiselect"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "checklist"
  | "person"
  | "relation"
  | "rollup"
  | "formula"
  | "created_at"
  | "updated_at"
  | "created_by"
  | "updated_by"
  | "files"
  | "id"
  | "progress";
export type Field = {
  id: string;
  name: string;
  type: FieldType;
  options?: string[];
  formula?: string;
  relationPage?: string;
  relationField?: string;
  rollupField?: string;
  aggregate?: import("./rollups").RollupAggregate;
  rollupDisplay?: "number" | "bar" | "ring" | "rating";
  rollupMax?: number;
  format?: string;
  timeFormat?: "24" | "12";
  decimals?: number;
  // "id": the ticket prefix, e.g. WEB for WEB-123.
  prefix?: string;
  // "relation" to the own database holding the parent record (subtasks).
  parent?: boolean;
  // "progress": share of done subtasks below a record. The done rule is
  // copied from the database settings by the server.
  parentField?: string;
  doneField?: string;
  doneValues?: string[];
};
export type Row = {
  id: string;
  page_id: string;
  cells: Record<string, unknown>;
  position: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
  // Running number in its database (ticket numbers).
  number?: number | null;
  content?: string;
  icon?: string;
  cover?: string;
  recurrence?: string;
  access?: import("./row-access-modes").RowAccessMode;
  // The viewer's role on this record (from the record permissions).
  role?: Role;
  grants?: { user_id: string; group_id: string; role: "viewer" | "editor" }[];
  preview?: import("./document-preview").DocumentPreview;
};
export type Filter = {
  field: string;
  op: (typeof import("./database-filters").filterOperators)[number];
  value: string;
  timeZone?: string;
  days?: number;
  // Several values (any_of, none_of, all_of) and the upper bound of between.
  values?: string[];
  to?: string;
};
export type FilterGroup = {
  kind: "group";
  join: "and" | "or";
  rules: FilterNode[];
};
export type FilterNode = (Filter & { kind: "condition" }) | FilterGroup;
export type View = {
  id: string;
  name: string;
  type:
    | "table"
    | "board"
    | "calendar"
    | "gallery"
    | "list"
    | "timeline"
    | "form"
    | "chart"
    | "feed";
  gallery?: import("./database-gallery").GalleryConfig;
  feed?: import("./database-feed").FeedConfig;
  timeline?: import("./database-timeline").TimelineConfig;
  calendar?: import("./database-calendar").CalendarConfig;
  chart?: import("./database-chart").ChartConfig;
  filters: Filter[];
  filterGroup?: FilterGroup;
  sorts: { field: string; direction: "asc" | "desc" }[];
  groupBy?: string;
  subGroupBy?: string;
  // Table: records below their parent record, as a tree (subtasks).
  tree?: boolean;
  // Board: work-in-progress limits per column (group key); `lock` refuses
  // further records instead of only marking the column.
  wip?: Record<string, { max: number; lock?: boolean }>;
  // Further grouping levels below the subgroups (levels 3 to 5).
  groupLevels?: string[];
  groupSettings?: {
    hideEmpty: boolean;
    sort: "manual" | "asc" | "desc";
    collapsed: string[];
    order?: string[];
  };
  dateField?: string;
  endDateField?: string;
  hiddenFields?: string[];
  fieldOrder?: string[];
  rowOrder?: string[];
  // Board only: card order per column (group key → row ids).
  groupRowOrder?: Record<string, string[]>;
  columnWidths?: Record<string, number>;
  calculations?: Record<string, import("./database-summary").CalculationChoice>;
};
export type Database = {
  page_id: string;
  fields: Field[];
  views: View[];
  version: number;
  recordLayout?: import("./record-layout").RecordLayout;
  settings?: import("./database-settings-schema").DatabaseSettings;
};
export type Comment = {
  id: string;
  page_id: string;
  row_id: string | null;
  author_id: string;
  name: string;
  body: string;
  resolved: number;
  created_at: string;
  reactions?: Reaction[];
};
export type Reaction = { emoji: string; count: number; mine: boolean; names: string[] };
export type Bootstrap = {
  user: Identity;
  localAccount?: boolean;
  workspaces: Workspace[];
  workspace: Workspace;
  spaces: Space[];
  trashedSpaces?: Space[];
  managedSpaces?: Space[];
  pages: Page[];
  favorites: string[];
  favoriteRows?: { pageId: string; rowId: string; title: string }[];
  savedSearches?: import("./saved-searches").SavedSearch[];
  recentVisits?: { pageId: string; seenAt: number }[];
  // Open tasks given to the person that are due today or overdue.
  dueTasks?: number;
  notificationPrefs?: import("./notification-kinds").NotificationPrefs;
  instance?: {
    name: string;
    announcement: string;
    allowWorkspaceCreation: boolean;
    // Voice notes can be turned into text (WHISPER_URL is set).
    transcription?: boolean;
  };
  members: (User & { role: Role; guest?: number })[];
  notifications: {
    row_id: string | null;
    thread_id: string | null;
    id: string;
    body: string;
    page_id: string | null;
    read_at: string | null;
    created_at: string;
  }[];
};
