// "Pfeil ↗ hinter Links zeigen" on a published page (#217): stored with the
// publication, preset from the publisher's own setting, changeable in the
// share dialog, and applied as a class on the page's root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-publication-link-icon-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { publicationSettings, publicationNotice } = await import("../lib/publication");
const { publicPageClass } = await import("../lib/public-page-class");
const { HIDE_EXTERNAL_LINK_ICON_CLASS } = await import("../lib/external-link-icon-pref");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  wid = await createWorkspace(owner.id, "Arrows"),
  space = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title })) as { id: string }).id;
const publish = (pageId: string, extra: Record<string, unknown> = {}) =>
  command(owner, { action: "page.publish", pageId, enabled: true, includeChildren: false, ...extra });
const linkIcon = async (pageId: string) => (await publicationSettings(pageId)).externalLinkIcon;

test("a new publication takes the publisher's setting; the dialog's switch changes it", async () => {
  // Default (never chosen): the arrow.
  const a = await create("Mit Pfeil");
  await publish(a);
  assert.equal(await linkIcon(a), true);
  assert.equal((await publicationNotice(a))?.external_link_icon, 1);

  // Turned off in the person's appearance settings: published without it.
  await command(owner, { action: "profile.externalLinkIcon", externalLinkIcon: false });
  const b = await create("Ohne Pfeil");
  await publish(b);
  assert.equal(await linkIcon(b), false);
  assert.equal((await publicationNotice(b))?.external_link_icon, 0);
  // An earlier publication keeps its own choice.
  assert.equal(await linkIcon(a), true);

  // The switch in the dialog, per publication.
  await publish(b, { externalLinkIcon: true });
  assert.equal(await linkIcon(b), true);
  // Other changes in the dialog without the field keep the choice, also
  // when the person's own setting says otherwise.
  await publish(b, { allowCopy: false });
  assert.equal(await linkIcon(b), true);
  await publish(a, { externalLinkIcon: false });
  assert.equal(await linkIcon(a), false);
  await command(owner, { action: "profile.externalLinkIcon", externalLinkIcon: true });
  await publish(a, { includeChildren: true });
  assert.equal(await linkIcon(a), false);

  // Unpublished and published again: the person's setting once more.
  await command(owner, { action: "page.publish", pageId: a, enabled: false });
  assert.equal(await one("SELECT 1 FROM publications WHERE page_id=?", a), undefined);
  await publish(a);
  assert.equal(await linkIcon(a), true);
});

test("only a boolean is accepted", async () => {
  const c = await create("Falsch");
  await assert.rejects(() => publish(c, { externalLinkIcon: "no" }));
});

test("the published page's root has the class only when the arrow is off", () => {
  const root = (externalLinkIcon: boolean) =>
    renderToStaticMarkup(createElement("main", { className: publicPageClass({ wide: false, themed: false, externalLinkIcon }) }));
  assert.equal(root(true), '<main class="public-page"></main>');
  assert.equal(root(false), `<main class="public-page ${HIDE_EXTERNAL_LINK_ICON_CLASS}"></main>`);
  assert.equal(publicPageClass({ wide: true, themed: true, externalLinkIcon: false }), `public-page public-wide public-themed ${HIDE_EXTERNAL_LINK_ICON_CLASS}`);
  // The stylesheet hides the arrow below a root with the class.
  const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
  assert.match(css, /\.public-page\.hide-external-link-icon :is\(\.document-editor, \.shared-rich-editor, \.inline-comment-panel\) a\[href\^="http"\]::after/);
});
