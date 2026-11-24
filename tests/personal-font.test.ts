// "Schriftart" (#512, lib/personal-font.ts, lib/user-font.ts): a typeface
// per person for the interface and the text of documents – saved on the
// server, validated, delivered with the bootstrap and set over the
// workspace's interface font; headings and code keep theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-personal-font-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const font = await import("../lib/personal-font");
const { BUNDLED_FONTS, DEFAULT_FONTS, SYSTEM_FONT, fontStack } = await import("../lib/theme-fonts");
const { themeCss } = await import("../lib/workspace-theme");
const { commandActions } = await import("../lib/openapi");
const { SETTINGS_SECTIONS } = await import("../lib/settings-sections");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");

test("the choices: the system font, Flowplan's own and the bundled text faces – no monospace, no display face", () => {
  assert.ok(font.PERSONAL_FONTS.includes(SYSTEM_FONT));
  assert.ok(font.PERSONAL_FONTS.includes(DEFAULT_FONTS.ui));
  for (const f of BUNDLED_FONTS) {
    if (f.category === "mono" || f.id === "instrument-serif") assert.ok(!font.PERSONAL_FONTS.includes(f.id), f.id);
    else if (!f.builtin) assert.ok(font.PERSONAL_FONTS.includes(f.id), f.id);
  }
  assert.equal(new Set(font.PERSONAL_FONTS).size, font.PERSONAL_FONTS.length);
  for (const value of [null, undefined, "", "jetbrains-mono", "instrument-serif", "custom:00000000-0000-0000-0000-000000000000", "INTER", 1, {}]) assert.equal(font.personalFontOf(value), null, String(value));
  assert.equal(font.personalFontOf("inter"), "inter");
});

test("a choice sets the interface face (UI and body text) on the root, over a workspace's look; headings and code stay", () => {
  assert.deepEqual(font.personalFontVariables(null), {});
  assert.equal(font.personalFontCss(null), "");
  assert.equal(font.personalFontCss("comic-sans"), "", "unknown values are the default");

  const vars = font.personalFontVariables("lora");
  assert.deepEqual(Object.keys(vars).sort(), ["--font-ui", "font-feature-settings"]);
  assert.equal(vars["--font-ui"], fontStack("ui", "lora"));
  assert.equal(vars["font-feature-settings"], "normal");
  assert.deepEqual(font.personalFontVariables(DEFAULT_FONTS.ui), { "--font-ui": fontStack("ui", DEFAULT_FONTS.ui)!, "font-feature-settings": `"ss01", "cv05"` });
  assert.match(font.personalFontVariables(SYSTEM_FONT)["--font-ui"], /^system-ui/);

  const css = font.personalFontCss("lora");
  assert.match(css, /^html:root:root:root\{--font-ui:"Lora", [^}]*;font-feature-settings:normal\}/);
  assert.doesNotMatch(css, /--font-display|--font-mono|--font-page-serif/);
  assert.match(css, /@font-face\{font-family:"Lora";[^}]*src:url\("\/fonts\/theme\/lora-latin-wght-normal\.woff2"\)/, "the bundled face from this server");
  assert.doesNotMatch(css, /https?:/, "nothing from elsewhere");
  assert.doesNotMatch(font.personalFontCss(SYSTEM_FONT), /@font-face/, "the system font needs no file");

  // More specific than a workspace's look in light and dark mode.
  const look = themeCss({ theme: { fonts: { ui: "inter", display: "lora" } }, fonts: [] }, (x) => x);
  assert.match(look, /html:root\{[^}]*--font-ui:/);
  assert.match(look, /html:root\[data-theme="dark"\]\{[^}]*--font-ui:/);
  // Specificity (pseudo-classes and attributes): html:root[data-theme] has 2, ours 3.
  assert.match(css, /^html(:root){3}\{/);
});

test("each person saves the choice; it is validated and delivered with the bootstrap", async () => {
  const anna = await account("font-anna"),
    ben = await account("font-ben");
  const wid = await createWorkspace(anna.id, "Schrift");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).uiFont, null, "never chosen: the default");
  assert.equal((await one<{ ui_font: string | null }>("SELECT ui_font FROM users WHERE id=?", anna.id))?.ui_font, null);

  assert.deepEqual(await command(anna, { action: "profile.font", font: "atkinson-hyperlegible-next" }), { font: "atkinson-hyperlegible-next" });
  assert.equal((await bootstrap(anna, wid)).uiFont, "atkinson-hyperlegible-next");
  assert.equal((await bootstrap(ben, wid)).uiFont, null, "only for that person");

  for (const bad of ["jetbrains-mono", "", "Inter", "custom:00000000-0000-0000-0000-000000000000", undefined, true, 1, { font: "inter" }])
    await rejects(() => command(anna, { action: "profile.font", font: bad }));
  assert.equal((await bootstrap(anna, wid)).uiFont, "atkinson-hyperlegible-next", "a rejected value changes nothing");

  // The workspace's look stays as it is; the person's choice comes along.
  await command(anna, { action: "workspace.theme", workspaceId: wid, theme: { fonts: { ui: "inter" } } });
  await command(anna, { action: "profile.font", font: SYSTEM_FONT });
  const boot = await bootstrap(anna, wid);
  assert.equal(boot.uiFont, SYSTEM_FONT);
  assert.deepEqual(boot.look?.theme, { fonts: { ui: "inter" } }, "the workspace's look is unchanged");
  assert.equal((await bootstrap(ben, wid)).look?.theme?.fonts?.ui, "inter");

  assert.deepEqual(await command(anna, { action: "profile.font", font: null }), { font: null });
  assert.equal((await bootstrap(anna, wid)).uiFont, null);
  // A value written outside Flowplan reads as the default.
  await run("UPDATE users SET ui_font=? WHERE id=?", "papyrus", ben.id);
  assert.equal((await bootstrap(ben, wid)).uiFont, null);
});

test("the command is documented in the API", () => {
  const doc = commandActions.find((a) => a.action === "profile.font");
  assert.ok(doc);
  assert.equal(doc!.input.safeParse({ action: "profile.font", font: "lora" }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.font", font: null }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.font", font: "fira-code" }).success, false);
});

test("the setting can be found in the settings search and is rendered by the app", () => {
  const appearance = SETTINGS_SECTIONS.find((s) => s.id === "appearance");
  assert.ok(appearance?.entries?.some((e) => e.anchor === "font"));
  const app = readFileSync(new URL("../components/workspace-app.tsx", import.meta.url), "utf8");
  assert.match(app, /<PersonalFontStyle font=\{boot\.uiFont\} \/>/);
  // Rendered after the workspace's look: the later rule wins as well.
  assert.ok(app.indexOf("<PersonalFontStyle") > app.indexOf("<WorkspaceThemeStyle"));
});
