// Shared and published pages follow the appearance of the person who shares
// or publishes them (#526, lib/public-appearance.ts): page icon placement,
// font and struck-through done tasks – stored with the publication or link,
// preset from that person's settings, a publication's changeable in the
// share dialog, and applied with classes and the font's style element.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-publication-appearance-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { publicationSettings, shareAppearance } = await import("../lib/publication");
const { publicPageClass } = await import("../lib/public-page-class");
const look = await import("../lib/public-appearance");
const { DONE_TASKS_PLAIN_CLASS } = await import("../lib/done-strike-pref");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  wid = await createWorkspace(owner.id, "Looks"),
  space = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title })) as { id: string }).id;
const publish = (pageId: string, extra: Record<string, unknown> = {}) =>
  command(owner, { action: "page.publish", pageId, enabled: true, includeChildren: false, ...extra });
const appearance = async (pageId: string) => (await publicationSettings(pageId)).appearance;
const token = async (pageId: string) => (await one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pageId))!.public_token;
const setMine = async (pageIcon: string, font: string | null, strikeDoneTasks: boolean) => {
  await command(owner, { action: "profile.pageIcon", pageIcon });
  await command(owner, { action: "profile.font", font });
  await command(owner, { action: "profile.strikeDoneTasks", strikeDoneTasks });
};

test("stored values: each field as stored, the rest from the fallback; classes for the root", () => {
  assert.deepEqual(look.publicAppearanceOf(null), look.DEFAULT_PUBLIC_APPEARANCE);
  assert.deepEqual(look.publicAppearanceOf("not json"), look.DEFAULT_PUBLIC_APPEARANCE);
  assert.deepEqual(look.publicAppearanceOf('{"pageIcon":"inline"}'), { pageIcon: "inline", font: null, strikeDoneTasks: true });
  assert.deepEqual(look.publicAppearanceOf('{"pageIcon":"left","font":"comic-sans","strikeDoneTasks":0}'), {
    pageIcon: "above",
    font: null,
    strikeDoneTasks: false,
  });
  const fallback = { pageIcon: "inline" as const, font: "lora", strikeDoneTasks: false };
  assert.deepEqual(look.publicAppearanceOf('{"font":null}', fallback), { pageIcon: "inline", font: null, strikeDoneTasks: false });
  const full = { pageIcon: "inline" as const, font: "lora", strikeDoneTasks: false };
  assert.deepEqual(look.publicAppearanceOf(look.publicAppearanceJson(full)), full);
  assert.deepEqual(look.publicAppearanceClasses(look.DEFAULT_PUBLIC_APPEARANCE), []);
  assert.deepEqual(look.publicAppearanceClasses(full), [look.PUBLIC_ICON_INLINE_CLASS, DONE_TASKS_PLAIN_CLASS]);
  assert.equal(
    publicPageClass({ wide: false, themed: false, externalLinkIcon: true, appearance: full }),
    `public-page ${look.PUBLIC_ICON_INLINE_CLASS} ${DONE_TASKS_PLAIN_CLASS}`,
  );
  assert.equal(publicPageClass({ wide: false, themed: false, externalLinkIcon: true, appearance: look.DEFAULT_PUBLIC_APPEARANCE }), "public-page");
});

test("a new publication takes the publisher's settings; the dialog changes only the publication", async () => {
  const a = await create("Standard");
  await publish(a);
  assert.deepEqual(await appearance(a), look.DEFAULT_PUBLIC_APPEARANCE);

  await setMine("inline", "lora", false);
  const b = await create("Wie ich");
  await publish(b);
  const mine = { pageIcon: "inline", font: "lora", strikeDoneTasks: false };
  assert.deepEqual(await appearance(b), mine);
  assert.deepEqual(await shareAppearance(await token(b)), mine, "what the public page renders");
  // An earlier publication keeps what it had.
  assert.deepEqual(await appearance(a), look.DEFAULT_PUBLIC_APPEARANCE);

  // The dialog: one field at a time, the others stay.
  await publish(b, { appearance: { pageIcon: "above" } });
  assert.deepEqual(await appearance(b), { ...mine, pageIcon: "above" });
  await publish(b, { appearance: { font: null, strikeDoneTasks: true } });
  assert.deepEqual(await appearance(b), { pageIcon: "above", font: null, strikeDoneTasks: true });
  // Not the person's own settings.
  const boot = await bootstrap(owner, wid);
  assert.equal(boot.pageIcon, "inline");
  assert.equal(boot.uiFont, "lora");
  assert.equal(boot.strikeDoneTasks, false);
  // Other changes in the dialog, and the person changing their settings
  // later, leave the publication's look alone.
  await publish(b, { allowCopy: false });
  await setMine("above", "inter", true);
  assert.deepEqual(await appearance(b), { pageIcon: "above", font: null, strikeDoneTasks: true });

  // Unpublished and published again: the person's settings once more.
  await command(owner, { action: "page.publish", pageId: b, enabled: false });
  await publish(b);
  assert.deepEqual(await appearance(b), { pageIcon: "above", font: "inter", strikeDoneTasks: true });
  await setMine("above", null, true);
});

test("only known values are accepted", async () => {
  const c = await create("Falsch");
  await assert.rejects(() => publish(c, { appearance: { pageIcon: "left" } }));
  await assert.rejects(() => publish(c, { appearance: { font: "comic-sans" } }));
  await assert.rejects(() => publish(c, { appearance: { strikeDoneTasks: "no" } }));
  await assert.rejects(() => publish(c, { appearance: { theme: "dark" } }), "nothing else");
  assert.equal(await one("SELECT 1 FROM publications WHERE page_id=?", c), undefined);
});

test("publications from before #526 use the publisher's current settings, and keep them once changed", async () => {
  const d = await create("Alt");
  await publish(d);
  await run("UPDATE publications SET appearance=NULL WHERE page_id=?", d);
  assert.deepEqual(await appearance(d), look.DEFAULT_PUBLIC_APPEARANCE);
  await setMine("inline", null, true);
  assert.deepEqual(await appearance(d), { pageIcon: "inline", font: null, strikeDoneTasks: true });
  assert.equal((await shareAppearance(await token(d))).pageIcon, "inline");
  // A change in the dialog stores the whole look.
  await publish(d, { appearance: { strikeDoneTasks: false } });
  await setMine("above", null, true);
  assert.deepEqual(await appearance(d), { pageIcon: "inline", font: null, strikeDoneTasks: false });
  // A publisher who is gone: the defaults.
  await run("UPDATE publications SET appearance=NULL,published_by=NULL WHERE page_id=?", d);
  assert.deepEqual(await appearance(d), look.DEFAULT_PUBLIC_APPEARANCE);
});

test("share links keep their creator's settings from when they were made", async () => {
  const e = await create("Link");
  await setMine("inline", "literata", false);
  const { token: link } = (await command(owner, { action: "share.create", pageId: e, name: "Team", role: "viewer" })) as { token: string };
  await setMine("above", null, true);
  assert.deepEqual(await shareAppearance(link), { pageIcon: "inline", font: "literata", strikeDoneTasks: false });
  // Links from before #526: the creator's current settings.
  await run("UPDATE share_links SET appearance=NULL WHERE token=?", link);
  assert.deepEqual(await shareAppearance(link), look.DEFAULT_PUBLIC_APPEARANCE);
  assert.deepEqual(await shareAppearance(id()), look.DEFAULT_PUBLIC_APPEARANCE, "unknown token");
});

test("the stylesheets place the icon next to the title and take the line away below the class", () => {
  const icons = readFileSync(join(process.cwd(), "app/page-icon-inline.css"), "utf8");
  assert.match(icons, /\.public-page\.public-icon-inline \.public-title \{[^}]*grid-template-columns: auto minmax\(0, 1fr\)/);
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  assert.match(css, /\.public-page\.done-tasks-plain :is\(\.document-editor, \.shared-rich-editor\) li\[data-checked="true"\] > div > :not\(ul, ol\) \{\s*text-decoration: none;/);
  // Cancelled tasks keep their line.
  assert.match(css, /\.public-page\.done-tasks-plain :is\(\.document-editor, \.shared-rich-editor\) ul\[data-type="taskList"\] > li\[data-status="cancelled"\] > div > :not\(ul, ol\) \{\s*text-decoration: line-through;/);
});
