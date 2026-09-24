export type Role = "owner" | "editor" | "viewer";
export type User = {
  id: string;
  name: string;
  email: string;
  disabled: number;
  created_at: string;
};
export type Identity = User & { groups: string[]; isAdmin: boolean };
export type Workspace = { id: string; name: string; icon: string; role: Role };
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
  kind: "document" | "database";
  position: number;
  deleted_at: string | null;
  created_by: string;
  updated_at: string;
  locked: number;
  public_token: string | null;
  full_width: number;
  font: string;
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
  | "files";
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
  rollupDisplay?: "number" | "bar" | "ring";
  rollupMax?: number;
  format?: string;
  timeFormat?: "24" | "12";
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
  content?: string;
  icon?: string;
  cover?: string;
  recurrence?: string;
  preview?: import("./document-preview").DocumentPreview;
};
export type Filter = {
  field: string;
  op: (typeof import("./database-filters").filterOperators)[number];
  value: string;
  timeZone?: string;
  days?: number;
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
  columnWidths?: Record<string, number>;
  calculations?: Record<string, import("./database-summary").CalculationChoice>;
};
export type Database = {
  page_id: string;
  fields: Field[];
  views: View[];
  version: number;
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
};
export type Bootstrap = {
  user: Identity;
  workspaces: Workspace[];
  workspace: Workspace;
  spaces: Space[];
  trashedSpaces?: Space[];
  managedSpaces?: Space[];
  pages: Page[];
  favorites: string[];
  favoriteRows?: { pageId: string; rowId: string; title: string }[];
  members: (User & { role: Role })[];
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
