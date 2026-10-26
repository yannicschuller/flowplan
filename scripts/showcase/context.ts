// Shared state and helpers while the showcase workspace is built.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { id, one, run } from "../../lib/db";
import { command, database } from "../../lib/api";
import { createPage } from "../../lib/seed";
import { htmlState } from "../../lib/document-server";
import { replaceRowDocument } from "../../lib/row-documents";
import type { Field, Identity, View } from "../../lib/types";

export type Lang = "de" | "en";
export type Person = { id: string; name: string; identity: Identity };

export class Ctx {
  pages: Record<string, string> = {};
  rows: Record<string, Record<string, string>> = {};
  constructor(
    public lang: Lang,
    public me: Identity,
    public team: Person[],
    public workspace: string,
    public spaces: Record<string, string>,
  ) {}
  t = (de: string, en: string) => (this.lang === "de" ? de : en);
  act = <T = Record<string, unknown>>(body: Record<string, unknown>, as: Identity = this.me): T => command(as, body) as T;

  // ---- dates ----
  day(offset: number) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  // A local date and time "YYYY-MM-DDTHH:mm".
  at(offset: number, time: string) {
    return `${this.day(offset)}T${time}`;
  }
  sqlTime(offsetDays: number, hour = 10) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    d.setHours(hour, (offsetDays * 7) % 60, 0, 0);
    return d.toISOString().replace("T", " ").slice(0, 19);
  }
  ms(offsetDays: number, hour = 10, minute = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  }

  // ---- pages ----
  page(key: string, space: string, title: string, kind = "document", parent: string | null = null, icon = "") {
    const pid = createPage(this.workspace, this.spaces[space], this.me.id, title, kind, parent);
    this.pages[key] = pid;
    if (icon) run("UPDATE pages SET icon=? WHERE id=?", icon, pid);
    return pid;
  }
  setHtml(pageId: string, html: string) {
    run("UPDATE documents SET html=?,state=?,generation=? WHERE page_id=?", html, htmlState(html), id(), pageId);
  }
  appearance(pageId: string, patch: { icon?: string; cover?: string; cover_position?: number; full_width?: number; font?: string; position?: number; updated_at?: string }) {
    for (const [key, value] of Object.entries(patch)) run(`UPDATE pages SET ${key}=? WHERE id=?`, value, pageId);
  }
  // ---- files ----
  file(pageId: string, name: string, mime: string, bytes: Buffer, by = this.me.id) {
    const fid = id();
    const dir = resolve(process.env.FLOWPLAN_DATA_DIR!, "uploads");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, fid), bytes);
    run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, name, mime, bytes.length, by);
    return fid;
  }
  url = (fileId: string) => `/api/files/${fileId}`;

  // ---- databases ----
  schema(pageId: string, fields: Field[], views: View[], extra: Record<string, unknown> = {}) {
    const d = database(pageId);
    this.act({ action: "database.update", pageId, version: d.version, fields, views, ...extra });
  }
  views(pageId: string, views: View[]) {
    const d = database(pageId);
    this.act({ action: "database.update", pageId, version: d.version, fields: d.fields, views });
  }
  layout(pageId: string, layout: Record<string, unknown>) {
    run("UPDATE databases SET record_layout=? WHERE page_id=?", JSON.stringify(layout), pageId);
  }
  row(pageId: string, cells: Record<string, unknown>, options: { html?: string; icon?: string; cover?: string; created?: number; by?: Identity } = {}) {
    const rid = this.act<{ id: string }>({ action: "row.create", pageId, cells }, options.by ?? this.me).id;
    if (options.html) replaceRowDocument(rid, options.html, this.me.id);
    if (options.icon || options.cover) run("UPDATE rows SET icon=?,cover=? WHERE id=?", options.icon ?? "", options.cover ?? "", rid);
    if (options.created !== undefined) run("UPDATE rows SET created_at=?,updated_at=? WHERE id=?", this.sqlTime(options.created), this.sqlTime(Math.min(0, options.created + 2)), rid);
    return rid;
  }
  update(pageId: string, rowId: string, cells: Record<string, unknown>) {
    const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId)!.version;
    this.act({ action: "row.update", pageId, rowId, version, cells });
  }
}

export const view = (vid: string, name: string, type: View["type"], extra: Partial<View> & Record<string, unknown> = {}) =>
  ({ id: vid, name, type, filters: [], sorts: [], ...extra }) as View;
