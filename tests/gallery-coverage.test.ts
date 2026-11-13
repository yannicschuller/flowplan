import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SCENES } from "../scripts/gallery/scenes";

// The UI gallery (npm run gallery, scripts/gallery) shows every dialog, menu
// and popover. A component file that renders one – the shared Modal of
// components/ui.tsx, or its own role="dialog" / "alertdialog" / "menu" –
// needs a scene that `covers` it, or an entry in scripts/gallery/uncovered.json.
// So a new dialog without a scene shows up here.

const root = join(import.meta.dirname, "..");
const DIALOG = /<Modal\b|role=["'](?:dialog|alertdialog|menu)["']/;
const UNCOVERED_FILE = "scripts/gallery/uncovered.json";

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const dialogFiles = ["components", "app"]
  .flatMap(sourceFiles)
  .filter((file) => DIALOG.test(readFileSync(join(root, file), "utf8")))
  .map((file) => relative(root, join(root, file)).split("\\").join("/"))
  .sort();
const covered = new Set(SCENES.flatMap((s) => s.covers ?? []));
const uncovered: string[] = JSON.parse(readFileSync(join(root, UNCOVERED_FILE), "utf8")).files;

test("every component with a dialog, menu or popover has a gallery scene", () => {
  const missing = dialogFiles.filter((file) => !covered.has(file) && !uncovered.includes(file));
  assert.deepEqual(
    missing,
    [],
    `These components render a dialog, menu or popover but no gallery scene shows them – add a gallery scene (scripts/gallery/scenes.ts, with covers: ["${missing[0]}"]) or list it in ${UNCOVERED_FILE}:\n  ${missing.join("\n  ")}`,
  );
});

test("the uncovered list of the gallery is honest", () => {
  const stale = uncovered.filter((file) => covered.has(file) || !dialogFiles.includes(file));
  assert.deepEqual(stale, [], `Remove these from ${UNCOVERED_FILE} – a scene covers them now, or they no longer render a dialog:\n  ${stale.join("\n  ")}`);
  assert.deepEqual(uncovered, [...uncovered].sort(), `Keep ${UNCOVERED_FILE} sorted.`);
});

test("gallery scenes have unique ids and cover files that exist", () => {
  const ids = SCENES.map((s) => s.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "Duplicate scene ids");
  for (const s of SCENES) assert.match(s.id, /^[a-z0-9-]+$/, `Scene id ${s.id}: lower-case words with dashes`);
  const gone = [...covered].filter((file) => !existsSync(join(root, file)));
  assert.deepEqual(gone, [], "Scenes cover files that do not exist");
});
