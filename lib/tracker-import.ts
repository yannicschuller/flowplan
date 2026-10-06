// Import from Jira (CSV export, "all fields") and Trello (board JSON export)
// into a new database: status, priority, type, people, labels, dates, story
// points, parents as subtasks, descriptions as the record's content,
// comments as comments and attachments as links (the files themselves stay
// at Jira or Trello, which need a sign-in to download them).
import Papa from "papaparse";
import { all, id, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireMember, spaceRole } from "./permissions";
import { createPage } from "./seed";
import { htmlState, escaped } from "./document-server";
import { markdownToHtml } from "./markdown-import";
import { ct } from "./content-locale";
import type { Field, Identity, Space, View } from "./types";

const MAX_ROWS = 5000;
type Record_ = {
  key: string;
  ref?: string;
  parentRef?: string;
  cells: Record<string, unknown>;
  html: string;
  comments: { author: string; at: string; text: string }[];
};
type Draft = { title: string; fields: Field[]; views: View[]; records: Record_[]; people: Map<string, string> };

const fieldId = () => id().slice(0, 8);
const unique = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))].slice(0, 100);
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${escaped(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

// "06/Oct/26 10:15 AM", "2026-10-06 10:15", ISO → YYYY-MM-DD
function day(value: string) {
  const v = value.trim();
  if (!v) return "";
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (iso) return iso[1];
  const jira = /^(\d{1,2})\/([A-Za-zäÄ]{3})\/(\d{2,4})/.exec(v);
  if (jira) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const german = { mär: "mar", mai: "may", okt: "oct", dez: "dec" } as Record<string, string>;
    const m = months.indexOf(german[jira[2].toLowerCase()] || jira[2].toLowerCase());
    if (m >= 0) {
      const year = jira[3].length === 2 ? 2000 + Number(jira[3]) : Number(jira[3]);
      return `${year}-${String(m + 1).padStart(2, "0")}-${jira[1].padStart(2, "0")}`;
    }
  }
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

/* ---------- Jira ---------- */

export function parseJira(csv: string, title = "Jira"): Draft {
  const parsed = Papa.parse<string[]>(csv.replace(/^﻿/, ""), { skipEmptyLines: true });
  const [header, ...lines] = parsed.data;
  if (!header?.includes("Summary")) throw new HttpError(400, "Das sieht nicht nach einem Jira-CSV-Export aus (Spalte „Summary“ fehlt).");
  if (lines.length > MAX_ROWS) throw new HttpError(413, `Maximal ${MAX_ROWS} Vorgänge je Import.`);
  const columns = (name: string | RegExp) =>
    header.flatMap((h, i) => (typeof name === "string" ? h.trim() === name : name.test(h.trim())) ? [i] : []);
  const first = (line: string[], name: string | RegExp) => columns(name).map((i) => line[i] || "").find((v) => v.trim()) || "";
  const many = (line: string[], name: string | RegExp) => columns(name).map((i) => line[i] || "").filter((v) => v.trim());
  const pointsColumn = /^(Custom field \()?(Story Points?|Story point estimate)\)?$/i;
  const f = {
    title: { id: "title", name: ct("Titel", "Title"), type: "text" } as Field,
    key: { id: fieldId(), name: ct("Jira-Schlüssel", "Jira key"), type: "text" } as Field,
    type: { id: fieldId(), name: ct("Typ", "Type"), type: "select", options: unique(lines.map((l) => first(l, "Issue Type"))) } as Field,
    status: { id: fieldId(), name: "Status", type: "select", options: unique(lines.map((l) => first(l, "Status"))) } as Field,
    priority: { id: fieldId(), name: ct("Priorität", "Priority"), type: "select", options: unique(lines.map((l) => first(l, "Priority"))) } as Field,
    assignee: { id: fieldId(), name: ct("Zuständig", "Assignee"), type: "text" } as Field,
    reporter: { id: fieldId(), name: ct("Gemeldet von", "Reporter"), type: "text" } as Field,
    labels: { id: fieldId(), name: "Labels", type: "multiselect", options: unique(lines.flatMap((l) => many(l, "Labels"))) } as Field,
    sprint: { id: fieldId(), name: "Sprint", type: "text" } as Field,
    points: { id: fieldId(), name: "Story Points", type: "number" } as Field,
    created: { id: fieldId(), name: ct("Erstellt", "Created"), type: "date" } as Field,
    due: { id: fieldId(), name: ct("Fällig", "Due"), type: "date" } as Field,
    resolved: { id: fieldId(), name: ct("Gelöst", "Resolved"), type: "date" } as Field,
    parent: { id: fieldId(), name: ct("Übergeordnet", "Parent"), type: "relation", parent: true } as Field,
  };
  const has = (name: string | RegExp) => columns(name).length > 0;
  const fields = [
    f.title,
    f.key,
    has("Issue Type") && f.type,
    has("Status") && f.status,
    has("Priority") && f.priority,
    has("Assignee") && f.assignee,
    has("Reporter") && f.reporter,
    has("Labels") && f.labels,
    has("Sprint") && f.sprint,
    has(pointsColumn) && f.points,
    has("Created") && f.created,
    has("Due date") && f.due,
    has("Resolved") && f.resolved,
    (has("Parent id") || has("Parent")) && f.parent,
  ].filter((x): x is Field => !!x);
  const records = lines.map((l): Record_ => {
    const comments = many(l, "Comment").map((c) => {
      // "06/Oct/26 10:15 AM;557058:abc;Text"
      const [at, author, ...text] = c.split(";");
      return text.length ? { at: day(at), author: author || "", text: text.join(";") } : { at: "", author: "", text: c };
    });
    const attachments = many(l, "Attachment").map((a) => {
      const parts = a.split(";");
      return { name: parts[2] || parts.at(-1) || a, url: parts.at(-1) || "" };
    });
    const description = first(l, "Description");
    const links = attachments.filter((a) => /^https?:\/\//.test(a.url));
    const html =
      paragraphs(description) +
      (links.length
        ? `<h3>${escaped(ct("Anhänge", "Attachments"))}</h3><ul>${links.map((a) => `<li><a href="${escaped(a.url)}">${escaped(a.name)}</a></li>`).join("")}</ul>`
        : "");
    const points = Number(first(l, pointsColumn).replace(",", "."));
    return {
      key: first(l, "Issue key"),
      ref: first(l, "Issue id"),
      parentRef: first(l, "Parent id") || first(l, "Parent"),
      cells: {
        title: first(l, "Summary"),
        [f.key.id]: first(l, "Issue key"),
        [f.type.id]: first(l, "Issue Type"),
        [f.status.id]: first(l, "Status"),
        [f.priority.id]: first(l, "Priority"),
        [f.assignee.id]: first(l, "Assignee"),
        [f.reporter.id]: first(l, "Reporter"),
        [f.labels.id]: unique(many(l, "Labels")),
        [f.sprint.id]: many(l, "Sprint").at(-1) || "",
        [f.points.id]: Number.isFinite(points) && first(l, pointsColumn) ? points : null,
        [f.created.id]: day(first(l, "Created")),
        [f.due.id]: day(first(l, "Due date")),
        [f.resolved.id]: day(first(l, "Resolved")),
      },
      html,
      comments,
    };
  });
  return finish(title, fields, records, f.status, f.assignee, f.parent);
}

/* ---------- Trello ---------- */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseTrello(json: string): Draft {
  let board: any;
  try {
    board = JSON.parse(json);
  } catch {
    throw new HttpError(400, "Die Datei ist kein gültiges JSON.");
  }
  if (!Array.isArray(board?.cards) || !Array.isArray(board?.lists))
    throw new HttpError(400, "Das sieht nicht nach einem Trello-Export aus (Karten oder Listen fehlen).");
  const cards = board.cards.filter((c: any) => !c.closed);
  if (cards.length > MAX_ROWS) throw new HttpError(413, `Maximal ${MAX_ROWS} Karten je Import.`);
  const lists = new Map<string, string>(board.lists.filter((l: any) => !l.closed).map((l: any) => [l.id, String(l.name || "")]));
  const members = new Map<string, string>((board.members || []).map((m: any) => [m.id, String(m.fullName || m.username || "")]));
  const labelName = (l: any) => String(l.name || l.color || "").trim();
  const f = {
    title: { id: "title", name: ct("Titel", "Title"), type: "text" } as Field,
    status: { id: fieldId(), name: ct("Liste", "List"), type: "select", options: unique([...lists.values()]) } as Field,
    labels: { id: fieldId(), name: "Labels", type: "multiselect", options: unique(cards.flatMap((c: any) => (c.labels || []).map(labelName))) } as Field,
    assignee: { id: fieldId(), name: ct("Mitglieder", "Members"), type: "text" } as Field,
    due: { id: fieldId(), name: ct("Fällig", "Due"), type: "date" } as Field,
    done: { id: fieldId(), name: ct("Erledigt", "Done"), type: "checkbox" } as Field,
    checklist: { id: fieldId(), name: ct("Checkliste", "Checklist"), type: "checklist" } as Field,
  };
  const comments = new Map<string, Record_["comments"]>();
  for (const a of board.actions || [])
    if (a.type === "commentCard" && a.data?.card?.id)
      comments.set(a.data.card.id, [
        ...(comments.get(a.data.card.id) || []),
        { author: String(a.memberCreator?.fullName || ""), at: day(String(a.date || "")), text: String(a.data.text || "") },
      ]);
  const checklists = new Map<string, any[]>();
  for (const c of board.checklists || []) checklists.set(c.idCard, [...(checklists.get(c.idCard) || []), ...(c.checkItems || [])]);
  const records = cards.map((c: any): Record_ => {
    const attachments = (c.attachments || []).filter((a: any) => /^https?:\/\//.test(String(a.url || "")));
    const html =
      (c.desc ? markdownToHtml(String(c.desc)) : "") +
      (attachments.length
        ? `<h3>${escaped(ct("Anhänge", "Attachments"))}</h3><ul>${attachments.map((a: any) => `<li><a href="${escaped(String(a.url))}">${escaped(String(a.name || a.url))}</a></li>`).join("")}</ul>`
        : "");
    return {
      key: String(c.idShort ?? ""),
      cells: {
        title: String(c.name || ""),
        [f.status.id]: lists.get(c.idList) || "",
        [f.labels.id]: unique((c.labels || []).map(labelName)),
        [f.assignee.id]: (c.idMembers || []).map((m: string) => members.get(m)).filter(Boolean).join(", "),
        [f.due.id]: c.due ? day(String(c.due)) : "",
        [f.done.id]: !!c.dueComplete,
        [f.checklist.id]: (checklists.get(c.id) || [])
          .slice(0, 100)
          .map((i: any) => ({ text: String(i.name || "").slice(0, 500), done: i.state === "complete" }))
          .filter((i: { text: string }) => i.text),
      },
      html,
      comments: (comments.get(c.id) || []).reverse(),
    };
  });
  return finish(String(board.name || "Trello"), Object.values(f), records, f.status, f.assignee);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function finish(title: string, fields: Field[], records: Record_[], status: Field, assignee: Field, parent?: Field): Draft {
  const views: View[] = [
    { id: id(), name: ct("Alle", "All"), type: "table", filters: [], sorts: [], ...(parent && fields.includes(parent) ? { tree: true } : {}) },
  ];
  if (fields.includes(status) && status.options?.length)
    views.push({ id: id(), name: "Board", type: "board", groupBy: status.id, filters: [], sorts: [] });
  return { title, fields, views, records, people: new Map([[assignee.id, assignee.name]]) };
}

// Creates the database from a draft. People are matched to members by name
// or e-mail: when all match, the property becomes a person property.
export function importTracker(user: Identity, workspaceId: string, spaceId: string, kind: "jira" | "trello", text: string, fileName = "") {
  requireMember(user, workspaceId, "editor");
  const space = one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL", spaceId, workspaceId);
  if (!space || !["editor", "owner"].includes(spaceRole(user, space) || "")) throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
  const draft = kind === "jira" ? parseJira(text, fileName.replace(/\.csv$/i, "") || "Jira") : parseTrello(text);
  const members = all<{ id: string; name: string; email: string }>(
    "SELECT u.id,u.name,u.email FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?",
    workspaceId,
  );
  const match = (name: string) => members.find((m) => m.name.toLowerCase() === name.toLowerCase() || m.email.toLowerCase() === name.toLowerCase());
  for (const [fid] of draft.people) {
    const field = draft.fields.find((f) => f.id === fid);
    const names = draft.records.map((r) => String(r.cells[fid] || "")).filter(Boolean);
    if (field && names.length && names.every((n) => !n.includes(",") && match(n))) {
      field.type = "person";
      for (const r of draft.records) r.cells[fid] = r.cells[fid] ? match(String(r.cells[fid]))!.id : "";
    }
  }
  return transaction(() => {
    const pageId = createPage(workspaceId, spaceId, user.id, draft.title.slice(0, 200) || "Import", "database");
    for (const f of draft.fields) if (f.parent) f.relationPage = pageId;
    run("UPDATE databases SET fields=?,views=? WHERE page_id=?", JSON.stringify(draft.fields), JSON.stringify(draft.views), pageId);
    const ids = new Map<string, string>();
    const parentField = draft.fields.find((f) => f.parent);
    draft.records.forEach((r, i) => {
      const rid = id();
      if (r.ref) ids.set(r.ref, rid);
      if (r.key) ids.set(r.key, rid);
      const cells = Object.fromEntries(Object.entries(r.cells).filter(([k]) => draft.fields.some((f) => f.id === k)));
      run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content) VALUES(?,?,?,?,?,?,?)",
        rid,
        pageId,
        JSON.stringify(cells),
        i,
        user.id,
        user.id,
        r.html,
      );
      if (r.html) run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rid, htmlState(r.html), r.html, id());
      for (const c of r.comments.slice(0, 200)) {
        const prefix = [c.author, c.at].filter(Boolean).join(", ");
        run(
          "INSERT INTO comments(id,page_id,row_id,author_id,body) VALUES(?,?,?,?,?)",
          id(),
          pageId,
          rid,
          user.id,
          `${prefix ? `${prefix}: ` : ""}${c.text}`.slice(0, 5000),
        );
      }
    });
    // Parents after all records exist (Jira lists children before parents).
    if (parentField)
      draft.records.forEach((r) => {
        const child = ids.get(r.ref || r.key);
        const parent = r.parentRef ? ids.get(r.parentRef) : undefined;
        if (!child || !parent || child === parent) return;
        const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", child)!;
        run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ ...JSON.parse(row.cells), [parentField.id]: [parent] }), child);
      });
    return { pageId, rows: draft.records.length, comments: draft.records.reduce((s, r) => s + r.comments.length, 0) };
  });
}
