// A workspace's look (#196, lib/workspace-theme.ts, lib/workspace-fonts.ts):
// the accent's palette in light and dark with WCAG contrast, the background
// presets, validation, the style sheet (only chosen faces), owner-only
// commands, uploaded fonts (magic bytes, size, quota), who may fetch them,
// and the look in workspace archives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-workspace-theme-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { workspaceBytes } = await import("../lib/instance-ops");
const { exportArchive, importArchive, readZip } = await import("../lib/archive");
const theme = await import("../lib/workspace-theme");
const fonts = await import("../lib/workspace-fonts");
const catalogue = await import("../lib/theme-fonts");
const shareFontRoute = await import("../app/api/share/[token]/fonts/[fontId]/route");

async function account(name: string, extra: Partial<Identity> = {}) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "", ...extra } as Identity;
}
const owner = await account("look-owner"),
  editor = await account("look-editor"),
  guest = await account("look-guest"),
  stranger = await account("look-stranger");
const wid = await createWorkspace(owner.id, "Hausfarben");
const other = await createWorkspace(stranger.id, "Anderswo");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);

const FONT_DIR = join(process.cwd(), "public/fonts/theme");
const inter = readFileSync(join(FONT_DIR, "inter-latin-wght-normal.woff2"));
const plexMono = readFileSync(join(FONT_DIR, "ibm-plex-mono-latin-400-normal.woff2"));
const file = (bytes: Buffer, name = "Hausschrift.woff2") => ({ name, bytes });
const upload = async (user: Identity, workspaceId: string, bytes: Buffer, name?: string) => await fonts.uploadWorkspaceFont(user, workspaceId, { name, file: file(bytes) });
const rejects = async (fn: () => Promise<unknown>, status: number) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === status || (status === 400 && (e as Error).name === "ZodError"));

// ---- Palette and contrast ----

const PICKS = ["#3b3fd8", "#ffffff", "#000000", "#ffff00", "#00ff00", "#00ffff", "#ff0000", "#ff00ff", "#808080", "#e11d48", "#10b981", "#000080", "#7f5f00", "#f4f4f4", "#0a0a0a"];

test("every derived palette reaches 4.5:1 for text on the accent and the accent on the backgrounds, in light and dark", () => {
  for (const preset of theme.BACKGROUND_PRESETS)
    for (const mode of ["light", "dark"] as const)
      for (const pick of PICKS) {
        const p = theme.derivePalette(pick, mode, preset.id);
        const s = preset[mode];
        const where = `${pick} ${mode} ${preset.id}`;
        assert.ok(theme.contrast(p.blue, p.onAccent) >= 4.5, `${where}: on-accent`);
        for (const bg of [s.bg, s.surface, s.sidebar, p.blueLight]) assert.ok(theme.contrast(p.blue, bg) >= 4.5, `${where}: accent on ${bg}`);
        // The strong accent (hover, emphasis) is at least as readable.
        assert.ok(theme.contrast(p.accentStrong, p.onAccent) >= 4.5, `${where}: on strong accent`);
        for (const value of [p.blue, p.blueLight, p.accentStrong, p.onAccent, p.focusBorder]) assert.match(value, /^#[0-9a-f]{6}$/);
        assert.match(p.focusRing, /^#[0-9a-f]{8}$/);
      }
});

test("a readable accent stays as picked in light mode; unreadable ones are adjusted and say so", () => {
  const flowplan = theme.derivePalette("#3b3fd8", "light");
  assert.equal(flowplan.blue, "#3b3fd8");
  assert.equal(flowplan.adjusted, false);
  assert.equal(flowplan.onAccent, "#ffffff");
  const black = theme.derivePalette("#000000", "light");
  assert.equal(black.blue, "#000000");
  assert.equal(black.adjusted, false);
  assert.notEqual(black.accentStrong, black.blue, "the strong accent differs even for black");
  for (const pick of ["#ffffff", "#ffff00", "#00ff00"]) {
    const p = theme.derivePalette(pick, "light");
    assert.equal(p.adjusted, true, pick);
    assert.ok(theme.hexToOklch(p.blue).l < theme.hexToOklch(pick).l, `${pick} gets darker`);
  }
  // The hue stays (yellow stays yellowish, not grey).
  const yellow = theme.hexToOklch(theme.derivePalette("#ffff00", "light").blue);
  assert.ok(Math.abs(yellow.h - theme.hexToOklch("#ffff00").h) < 6 && yellow.c > 0.05);
});

test("dark mode uses a light version of the accent with dark text on it", () => {
  const navy = theme.derivePalette("#000080", "dark");
  assert.ok(theme.hexToOklch(navy.blue).l >= 0.72);
  assert.equal(navy.onAccent, "#121117");
  assert.equal(theme.derivePalette("#ffff00", "dark").blue, "#ffff00", "a light accent stays as it is");
  const white = theme.derivePalette("#ffffff", "dark");
  assert.equal(white.blue, "#ffffff");
  assert.equal(white.adjusted, false);
  const black = theme.derivePalette("#000000", "dark");
  assert.ok(theme.contrast(black.blue, "#16151b") >= 4.5);
  // Each preset's own darkest background is the text on the accent.
  assert.equal(theme.derivePalette("#3b3fd8", "dark", "sepia").onAccent, theme.backgroundPreset("sepia").dark.sidebar);
});

test("OKLCH round trip and the WCAG contrast formula", () => {
  for (const hex of PICKS) assert.equal(theme.oklchToHex(theme.hexToOklch(hex)), hex);
  assert.equal(Math.round(theme.contrast("#ffffff", "#000000") * 100) / 100, 21);
  assert.equal(theme.contrast("#777777", "#777777"), 1);
});

test("the text colours keep their contrast on every background preset", () => {
  const text = { light: { text: "#1d1c22", muted: "#6f6b78", secondary: "#5e5a66" }, dark: { text: "#ecebf1", muted: "#8e8a98", secondary: "#b3afbd" } };
  for (const preset of theme.BACKGROUND_PRESETS)
    for (const mode of ["light", "dark"] as const)
      for (const [name, colour] of Object.entries(text[mode]))
        for (const bg of ["bg", "surface", "sidebar"] as const)
          assert.ok(theme.contrast(colour, preset[mode][bg]) >= 4.5, `${preset.id} ${mode} ${name} on ${bg}`);
  // "Standard" is Flowplan's own (app/globals.css).
  const css = readFileSync("app/globals.css", "utf8");
  const standard = theme.backgroundPreset("standard");
  for (const [key, value] of Object.entries(standard.light)) assert.ok(css.slice(0, 2000).includes(`--${key}: ${value};`), `light ${key}`);
  const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
  for (const [key, value] of Object.entries(standard.dark)) assert.ok(dark.slice(0, 600).includes(`--${key}: ${value};`), `dark ${key}`);
});

// ---- Validation and the style sheet ----

test("the theme schema takes hex colours, preset ids and known font ids only", () => {
  const ok = theme.workspaceThemeSchema.parse({ accent: "#AABBCC", background: "sepia", fonts: { ui: "inter", display: "lora", mono: `custom:${id()}` } });
  assert.equal(ok.accent, "#aabbcc");
  for (const bad of [
    { accent: "red" },
    { accent: "#abc" },
    { accent: "#aabbcc;}" },
    { background: "purple" },
    { fonts: { ui: "comic-sans" } },
    { fonts: { ui: "custom:../../etc" } },
    { fonts: { body: "inter" } },
    { css: "body{}" },
  ])
    assert.equal(theme.workspaceThemeSchema.safeParse(bad).success, false, JSON.stringify(bad));
  // Defaults fall away; nothing left is no theme at all.
  assert.equal(theme.normalizeTheme({ accent: null, background: "standard", fonts: { ui: "instrument-sans", display: "instrument-serif", mono: "jetbrains-mono" } }), null);
  assert.deepEqual(theme.normalizeTheme({ background: "standard", fonts: { ui: "inter" } }), { fonts: { ui: "inter" } });
  assert.equal(theme.parseTheme("{not json"), null);
  assert.equal(theme.parseTheme(JSON.stringify({ accent: "nope" })), null);
});

test("the default look writes no CSS; a look sets variables for light and dark and only the faces it uses", () => {
  assert.equal(theme.themeCss(null, theme.appFontUrl), "");
  assert.equal(theme.themeCss({ theme: null, fonts: [] }, theme.appFontUrl), "");
  const css = theme.themeCss({ theme: { accent: "#e11d48", background: "cool", fonts: { ui: "inter", mono: "ibm-plex-mono" } }, fonts: [] }, theme.appFontUrl);
  assert.match(css, /html:root\{[^}]*--blue:#[0-9a-f]{6};/);
  assert.match(css, /html:root\[data-theme="dark"\]\{[^}]*--blue:#[0-9a-f]{6};/);
  assert.match(css, /--bg:#f9fbfd/);
  assert.match(css, /--font-ui:"Inter"/);
  assert.match(css, /font-feature-settings:normal/);
  assert.ok(css.includes('url("/fonts/theme/inter-latin-wght-normal.woff2")'));
  assert.ok(css.includes('url("/fonts/theme/ibm-plex-mono-latin-ext-700-normal.woff2")'));
  assert.ok(!/lora|literata|merriweather|garamond|fira|lexend/i.test(css), "no other bundled face");
  assert.ok(!css.includes("--font-display"), "the heading face stays");
  // A heading face also sets pages in "Serif".
  assert.match(theme.themeCss({ theme: { fonts: { display: "lora" } }, fonts: [] }, theme.appFontUrl), /--font-page-serif:var\(--font-display\)/);
  // Accent only: no font rules at all.
  const accentOnly = theme.themeCss({ theme: { accent: "#0f766e" }, fonts: [] }, theme.appFontUrl);
  assert.ok(!accentOnly.includes("@font-face") && !accentOnly.includes("--font-"));
  // An uploaded face: named after its id, loaded from where the page says.
  const fid = id();
  const custom = theme.themeCss({ theme: { fonts: { ui: `custom:${fid}` } }, fonts: [{ id: fid, name: 'Evil"}body{x', format: "woff2", variable: true }] }, (f) => `/api/share/tok/fonts/${f}`);
  assert.ok(custom.includes(`font-family:"wsf-${fid}"`));
  assert.ok(custom.includes(`url("/api/share/tok/fonts/${fid}")`));
  assert.ok(!custom.includes("Evil"), "the name never reaches the CSS");
  assert.ok(custom.includes("font-weight:100 1000"));
  // A face that is gone is left out.
  assert.ok(!theme.themeCss({ theme: { fonts: { ui: `custom:${id()}` } }, fonts: [] }, theme.appFontUrl).includes("wsf-"));
});

test("the default look of app/globals.css is unchanged by the new variables", () => {
  const css = readFileSync("app/globals.css", "utf8");
  for (const declaration of ["--focus-border: #8ab4f4;", "--focus-ring: #3b3fd81a;", "--cell-selection: #3b3fd81f;", "--primary-hover: #2468cf;", "--font-page-serif: Georgia, serif;"])
    assert.ok(css.slice(0, 3000).includes(declaration), declaration);
  assert.ok(!/#8ab4f4|#3b3fd81a|#3b3fd81f|#2468cf/.test(css.slice(3000)), "the old literals are variables now");
});

test("every bundled face has its files and licence; nothing else lies in public/fonts/theme", () => {
  const listed = new Set(catalogue.bundledFontFiles());
  const present = readdirSync(FONT_DIR);
  for (const name of listed) assert.ok(present.includes(name), `${name} missing`);
  for (const name of present.filter((n) => n.endsWith(".woff2"))) assert.ok(listed.has(name), `${name} not in the catalogue`);
  const licences = present.filter((n) => n.startsWith("LICENSE-"));
  assert.equal(licences.length, catalogue.BUNDLED_FONTS.filter((f) => !f.builtin).length);
  for (const name of licences) assert.match(readFileSync(join(FONT_DIR, name), "utf8"), /SIL Open Font License, Version 1\.1/);
  assert.ok(catalogue.BUNDLED_FONTS.length >= 18);
  // The handwriting and ink faces are not part of it (lib/ink/fonts.ts).
  assert.ok(!catalogue.BUNDLED_FONT_IDS.some((f) => /caveat|patrick/.test(f)));
  assert.ok(existsSync("public/fonts.css") && !readFileSync("public/fonts.css", "utf8").includes("/fonts/theme/"), "fonts.css loads no theme face");
});

// ---- Font files ----

test("font files are recognised by their bytes, variable fonts by their fvar table", () => {
  assert.deepEqual(fonts.sniffFont(inter), { format: "woff2", mime: "font/woff2", variable: true });
  assert.deepEqual(fonts.sniffFont(plexMono), { format: "woff2", mime: "font/woff2", variable: false });
  // A minimal TrueType / OpenType directory.
  const sfnt = (magic: Buffer, tags: string[]) => {
    const out = Buffer.alloc(12 + tags.length * 16 + 64);
    magic.copy(out, 0);
    out.writeUInt16BE(tags.length, 4);
    tags.forEach((t, i) => out.write(t, 12 + i * 16, "latin1"));
    return out;
  };
  assert.equal(fonts.sniffFont(sfnt(Buffer.from([0, 1, 0, 0]), ["cmap", "head", "glyf"]))?.format, "truetype");
  assert.deepEqual(fonts.sniffFont(sfnt(Buffer.from("OTTO"), ["CFF ", "cmap", "fvar", "head"])), { format: "opentype", mime: "font/otf", variable: true });
  assert.equal(fonts.sniffFont(sfnt(Buffer.from([0, 1, 0, 0]), ["abcd"])), null, "no font tables");
  assert.equal(fonts.sniffFont(Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(100, 0xff)])), null, "a magic alone is not a font");
  assert.equal(fonts.sniffFont(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>".padEnd(200))), null);
  assert.equal(fonts.sniffFont(Buffer.concat([Buffer.from("ttcf"), Buffer.alloc(100)])), null, "no collections");
});

test("uploads: owners only, real fonts only, at most 5 MB, against the workspace quota", async () => {
  await rejects(() => upload(editor, wid, inter), 403);
  await rejects(() => upload(guest, wid, inter), 403);
  await rejects(() => upload(stranger, wid, inter), 403);
  await rejects(() => upload(owner, wid, Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n"), Buffer.alloc(500)])), 400);
  await rejects(() => upload(owner, wid, Buffer.concat([inter, Buffer.alloc(fonts.FONT_LIMITS.bytes)])), 413);
  const before = await workspaceBytes(wid);
  const font = await upload(owner, wid, inter, "Hausschrift");
  assert.equal(font.name, "Hausschrift");
  assert.equal(font.variable, true);
  assert.equal((await workspaceBytes(wid)) - before, inter.length, "counted in the workspace's storage");
  // An integer quota (bigint on PostgreSQL): the next upload would exceed it.
  const quotaMb = Math.ceil((await workspaceBytes(wid)) / 1024 / 1024);
  await run("UPDATE workspaces SET quota_mb=? WHERE id=?", quotaMb, wid);
  const padded = Buffer.concat([inter, Buffer.alloc(quotaMb * 1024 * 1024)]).subarray(0, Math.min(fonts.FONT_LIMITS.bytes, quotaMb * 1024 * 1024 + 10));
  await rejects(() => upload(owner, wid, padded), 413);
  await run("UPDATE workspaces SET quota_mb=NULL WHERE id=?", wid);
  // The name falls back to the file's.
  const unnamed = await fonts.uploadWorkspaceFont(owner, wid, { name: "", file: file(plexMono, "Plex Mono.woff2") });
  assert.equal(unnamed.name, "Plex Mono");
  assert.equal(unnamed.variable, false);
  await command(owner, { action: "workspace.font.delete", workspaceId: wid, fontId: unnamed.id });
});

// ---- Commands ----

test("only owners set the look; tokens follow the usual rules; everyone gets it in the bootstrap", async () => {
  const look = { accent: "#0F766E", background: "sepia", fonts: { ui: "atkinson-hyperlegible-next", display: "source-serif-4" } };
  await rejects(() => command(editor, { action: "workspace.theme", workspaceId: wid, theme: look }), 403);
  await rejects(() => command(guest, { action: "workspace.theme", workspaceId: wid, theme: look }), 403);
  await rejects(() => command(stranger, { action: "workspace.theme", workspaceId: wid, theme: look }), 403);
  await rejects(() => command({ ...owner, apiScope: "read" }, { action: "workspace.theme", workspaceId: wid, theme: look }), 403);
  await rejects(() => command(owner, { action: "workspace.theme", workspaceId: wid, theme: { ...look, accent: "url(x)" } }), 400);
  await rejects(() => command(owner, { action: "workspace.theme", workspaceId: wid, theme: { customCss: "body{}" } }), 400);
  const saved = (await command({ ...owner, apiScope: "write" }, { action: "workspace.theme", workspaceId: wid, theme: look })) as import("../lib/workspace-theme").WorkspaceLook;
  assert.deepEqual(saved.theme, { ...look, accent: "#0f766e" });
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workspace.theme' AND resource_id=?", wid), "recorded in the activity log");
  for (const user of [owner, editor, guest]) {
    const boot = await bootstrap(user, wid);
    assert.deepEqual(boot.look.theme, saved.theme, user.name);
    assert.equal(boot.plainLook, false);
    assert.ok(!boot.workspaces.some((w) => "theme" in w), "the raw column stays out of the list");
  }
  // Members read the full list of faces (settings); others do not.
  assert.ok(Array.isArray(((await command(editor, { action: "workspace.look", workspaceId: wid })) as { fonts: unknown[] }).fonts));
  await rejects(() => command(stranger, { action: "workspace.look", workspaceId: wid }), 403);
});

test("a look may use only the workspace's own uploaded faces; deleting one resets its slots", async () => {
  const foreign = await upload(stranger, other, inter, "Fremd");
  await rejects(() => command(owner, { action: "workspace.theme", workspaceId: wid, theme: { fonts: { ui: `custom:${foreign.id}` } } }), 400);
  const own = await upload(owner, wid, inter, "Eigen");
  await command(owner, { action: "workspace.theme", workspaceId: wid, theme: { accent: "#7c3aed", fonts: { ui: `custom:${own.id}`, display: `custom:${own.id}`, mono: "fira-code" } } });
  const boot = await bootstrap(guest, wid);
  assert.deepEqual(boot.look.fonts.map((f) => f.id), [own.id], "the bootstrap carries the faces in use");
  await rejects(() => command(editor, { action: "workspace.font.delete", workspaceId: wid, fontId: own.id }), 403);
  await rejects(() => command(owner, { action: "workspace.font.delete", workspaceId: wid, fontId: foreign.id }), 404);
  const after = (await command(owner, { action: "workspace.font.delete", workspaceId: wid, fontId: own.id })) as import("../lib/workspace-theme").WorkspaceLook;
  assert.deepEqual(after.theme, { accent: "#7c3aed", fonts: { mono: "fira-code" } });
  assert.ok(!after.fonts.some((f) => f.id === own.id));
  // Back to Flowplan's own look.
  await command(owner, { action: "workspace.theme", workspaceId: wid, theme: null });
  assert.equal((await one<{ theme: string | null }>("SELECT theme FROM workspaces WHERE id=?", wid))?.theme, null);
});

test("each person may choose Flowplan's own look", async () => {
  assert.deepEqual(await command(editor, { action: "profile.plainLook", plain: true }), { plainLook: true });
  assert.equal((await bootstrap(editor, wid)).plainLook, true);
  assert.equal((await bootstrap(owner, wid)).plainLook, false, "only for that person");
  await rejects(() => command(editor, { action: "profile.plainLook", plain: "yes" }), 400);
  await command(editor, { action: "profile.plainLook", plain: false });
  assert.equal((await bootstrap(editor, wid)).plainLook, false);
});

// ---- Who may fetch a face ----

test("members and guests fetch the workspace's faces, nobody else; publications only their own workspace's", async () => {
  const own = await upload(owner, wid, inter, "Hausschrift");
  const foreign = await upload(stranger, other, plexMono, "Fremd");
  for (const user of [owner, editor, guest]) assert.equal((await fonts.workspaceFontFile(own.id, { user })).data.length, inter.length, user.name);
  await rejects(() => fonts.workspaceFontFile(own.id, { user: stranger }), 404);
  await rejects(() => fonts.workspaceFontFile(foreign.id, { user: guest }), 404);
  await rejects(() => fonts.workspaceFontFile("../../etc/passwd", { user: owner }), 404);
  const response = fonts.fontResponse(await fonts.workspaceFontFile(own.id, { user: owner }));
  assert.equal(response.headers.get("content-type"), "font/woff2");
  assert.match(response.headers.get("cache-control")!, /max-age=31536000/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  // A published page of the workspace serves its faces, not another's.
  const sid = (await bootstrap(owner, wid)).spaces[0].id;
  const pid = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Öffentlich" })) as { id: string }).id;
  await command(owner, { action: "page.publish", pageId: pid, enabled: true });
  const token = (await one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pid))!.public_token;
  const fetchFont = async (fontId: string) =>
    await shareFontRoute.GET(new Request(`https://flowplan.example.test/api/share/${token}/fonts/${fontId}`), { params: Promise.resolve({ token, fontId }) });
  const served = await fetchFont(own.id);
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).length, inter.length);
  assert.equal((await fetchFont(foreign.id)).status, 404);
  assert.equal((await shareFontRoute.GET(new Request("https://x/"), { params: Promise.resolve({ token: "nope", fontId: own.id }) })).status, 404);
  // Removed with the workspace.
  const gone = await createWorkspace(owner.id, "Vergänglich");
  await upload(owner, gone, inter);
  await run("DELETE FROM workspaces WHERE id=?", gone);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workspace_fonts WHERE workspace_id=?", gone))?.n), 0);
});

// ---- Archives ----

test("the look and its uploaded faces travel in the workspace archive", async () => {
  const face = await upload(owner, wid, inter, "Archivschrift");
  await command(owner, { action: "workspace.theme", workspaceId: wid, theme: { accent: "#be123c", background: "neutral", fonts: { ui: `custom:${face.id}`, mono: "source-code-pro" } } });
  const zip = await exportArchive(owner, wid);
  const entries = await readZip(zip);
  const manifest = JSON.parse(entries.get("flowplan.json")!.toString("utf8"));
  assert.equal(manifest.look.theme.accent, "#be123c");
  assert.ok(manifest.look.fonts.some((f: { id: string }) => f.id === face.id));
  assert.ok(entries.has(`fonts/${face.id}`));
  // Guests export only their pages: no look.
  const guestManifest = JSON.parse((await readZip(await exportArchive(guest, wid))).get("flowplan.json")!.toString("utf8"));
  assert.equal(guestManifest.look, undefined);
  // Into a new workspace of an owner: taken over, the face with a new id.
  const target = await createWorkspace(editor.id, "Ziel");
  await importArchive(editor, target, zip);
  const imported = await fonts.workspaceLook(target, true);
  assert.equal(imported.theme?.accent, "#be123c");
  assert.equal(imported.theme?.background, "neutral");
  const newFace = imported.fonts.find((f) => f.name === "Archivschrift");
  assert.ok(newFace && newFace.id !== face.id);
  assert.equal(imported.theme?.fonts?.ui, `custom:${newFace.id}`);
  assert.equal(imported.theme?.fonts?.mono, "source-code-pro");
  // A workspace that has a look keeps it.
  const styled = await createWorkspace(editor.id, "Eigenes");
  await command(editor, { action: "workspace.theme", workspaceId: styled, theme: { accent: "#15803d" } });
  await importArchive(editor, styled, zip);
  assert.deepEqual((await fonts.workspaceLook(styled)).theme, { accent: "#15803d" });
  // An editor (not owner) imports pages, not the look.
  const shared = await createWorkspace(stranger.id, "Geteilt");
  await run("INSERT INTO members VALUES(?,?,?)", shared, editor.id, "editor");
  await importArchive(editor, shared, zip);
  assert.equal((await fonts.workspaceLook(shared)).theme, null);
  // A tampered font entry is refused like any other file.
  const { writeZip } = await import("../lib/archive");
  const tampered = new Map(entries);
  tampered.set(`fonts/${face.id}`, Buffer.concat([inter, Buffer.from("x")]));
  await rejects(async () => await importArchive(editor, target, await writeZip(tampered)), 400);
});
