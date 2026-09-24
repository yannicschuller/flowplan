import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-backlinks-"),
);
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { relationBacklinks } = await import("../lib/relation-backlinks");

function account(name: string) {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}

test("backlinks list readable records whose relations point at a record", () => {
  const owner = account("bl-owner"),
    member = account("bl-member");
  const wid = createWorkspace(owner.id, "Verknüpfungen");
  run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
  const team = bootstrap(owner, wid).spaces[0].id;
  const secret = (
    command(owner, {
      action: "space.create",
      workspaceId: wid,
      name: "Privat",
      private: true,
    }) as { id: string }
  ).id;
  const db = (title: string, spaceId = team) =>
    (
      command(owner, {
        action: "page.create",
        workspaceId: wid,
        spaceId,
        title,
        kind: "database",
      }) as { id: string }
    ).id;
  const projects = db("Projekte"),
    tasks = db("Aufgaben"),
    notes = db("Notizen", secret);
  const schema = (page: string, fields: unknown[]) =>
    command(owner, {
      action: "database.update",
      pageId: page,
      version: database(page).version,
      fields,
      views: database(page).views,
    });
  schema(tasks, [
    { id: "title", name: "Name", type: "text" },
    {
      id: "project",
      name: "Projekt",
      type: "relation",
      relationPage: projects,
    },
  ]);
  schema(notes, [
    { id: "title", name: "Name", type: "text" },
    { id: "project", name: "Bezug", type: "relation", relationPage: projects },
  ]);
  schema(projects, [
    { id: "title", name: "Name", type: "text" },
    {
      id: "parent",
      name: "Übergeordnet",
      type: "relation",
      relationPage: projects,
    },
  ]);
  const row = (page: string, cells: Record<string, unknown>) =>
    (
      command(owner, { action: "row.create", pageId: page, cells }) as {
        id: string;
      }
    ).id;
  const alpha = row(projects, { title: "Alpha" });
  row(projects, { title: "Alpha 2", parent: [alpha] });
  row(tasks, { title: "Entwurf", project: [alpha] });
  row(tasks, { title: "Anderes", project: [] });
  row(notes, { title: "Geheim", project: [alpha] });
  const titles = (user: Identity) =>
    relationBacklinks(user, projects, alpha)
      .map((l) => `${l.pageTitle}:${l.title}:${l.field}`)
      .sort();
  assert.deepEqual(titles(owner), [
    "Aufgaben:Entwurf:Projekt",
    "Notizen:Geheim:Bezug",
    "Projekte:Alpha 2:Übergeordnet",
  ]);
  // Records in private areas stay hidden from other members.
  assert.deepEqual(titles(member), [
    "Aufgaben:Entwurf:Projekt",
    "Projekte:Alpha 2:Übergeordnet",
  ]);
  assert.deepEqual(relationBacklinks(owner, projects, id()), []);
  assert.throws(
    () => relationBacklinks(account("stranger"), projects, alpha),
    /Berechtigung/,
  );
});
