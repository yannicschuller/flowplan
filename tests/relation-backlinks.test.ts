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

async function account(name: string) {
  const uid = id();
  await run(
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

test("backlinks list readable records whose relations point at a record", async () => {
  const owner = await account("bl-owner"),
    member = await account("bl-member");
  const wid = await createWorkspace(owner.id, "Verknüpfungen");
  await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
  const team = (await bootstrap(owner, wid)).spaces[0].id;
  const secret = (
    (await command(owner, {
      action: "space.create",
      workspaceId: wid,
      name: "Privat",
      private: true,
    })) as { id: string }
  ).id;
  const db = async (title: string, spaceId = team) =>
    (
      (await command(owner, {
        action: "page.create",
        workspaceId: wid,
        spaceId,
        title,
        kind: "database",
      })) as { id: string }
    ).id;
  const projects = await db("Projekte"),
    tasks = await db("Aufgaben"),
    notes = await db("Notizen", secret);
  const schema = async (page: string, fields: unknown[]) =>
    await command(owner, {
      action: "database.update",
      pageId: page,
      version: (await database(page)).version,
      fields,
      views: (await database(page)).views,
    });
  await schema(tasks, [
    { id: "title", name: "Name", type: "text" },
    {
      id: "project",
      name: "Projekt",
      type: "relation",
      relationPage: projects,
    },
  ]);
  await schema(notes, [
    { id: "title", name: "Name", type: "text" },
    { id: "project", name: "Bezug", type: "relation", relationPage: projects },
  ]);
  await schema(projects, [
    { id: "title", name: "Name", type: "text" },
    {
      id: "parent",
      name: "Übergeordnet",
      type: "relation",
      relationPage: projects,
    },
  ]);
  const row = async (page: string, cells: Record<string, unknown>) =>
    (
      (await command(owner, { action: "row.create", pageId: page, cells })) as {
        id: string;
      }
    ).id;
  const alpha = await row(projects, { title: "Alpha" });
  await row(projects, { title: "Alpha 2", parent: [alpha] });
  await row(tasks, { title: "Entwurf", project: [alpha] });
  await row(tasks, { title: "Anderes", project: [] });
  await row(notes, { title: "Geheim", project: [alpha] });
  const titles = async (user: Identity) =>
    (await relationBacklinks(user, projects, alpha))
      .map((l) => `${l.pageTitle}:${l.title}:${l.field}`)
      .sort();
  assert.deepEqual(await titles(owner), [
    "Aufgaben:Entwurf:Projekt",
    "Notizen:Geheim:Bezug",
    "Projekte:Alpha 2:Übergeordnet",
  ]);
  // Records in private areas stay hidden from other members.
  assert.deepEqual(await titles(member), [
    "Aufgaben:Entwurf:Projekt",
    "Projekte:Alpha 2:Übergeordnet",
  ]);
  assert.deepEqual(await relationBacklinks(owner, projects, id()), []);
  await assert.rejects(
    async () => await relationBacklinks(await account("stranger"), projects, alpha),
    /Berechtigung/,
  );
});
