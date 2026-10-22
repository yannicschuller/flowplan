// The registry of settings sections (lib/settings-sections.ts): addresses,
// old tab links and the search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEGACY_SECTIONS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  findSection,
  matchesQuery,
  parseSettingsHash,
  settingsHash,
} from "../lib/settings-sections";

test("section ids are unique per area and belong to a group of that area", () => {
  for (const area of ["settings", "admin"] as const) {
    const ids = SETTINGS_SECTIONS.filter((s) => s.area === area).map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${area}`);
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/, `${id} is not a plain address`);
  }
  for (const s of SETTINGS_SECTIONS)
    assert.ok(SETTINGS_GROUPS.some((g) => g.id === s.group && g.area === s.area), `${s.area}/${s.id}: unknown group ${s.group}`);
  for (const g of SETTINGS_GROUPS) assert.ok(SETTINGS_SECTIONS.some((s) => s.group === g.id && s.area === g.area), `empty group ${g.id}`);
});

test("addresses: landing page, section, anchor and back", () => {
  assert.deepEqual(parseSettingsHash("#settings"), { area: "settings", section: null, anchor: null, redirected: false });
  assert.deepEqual(parseSettingsHash("#admin/users"), { area: "admin", section: "users", anchor: null, redirected: false });
  assert.deepEqual(parseSettingsHash("#settings/account/passkeys"), { area: "settings", section: "account", anchor: "passkeys", redirected: false });
  assert.equal(parseSettingsHash("#home"), null);
  assert.equal(parseSettingsHash("#page=abc"), null);
  // Unknown sections open the landing page.
  assert.deepEqual(parseSettingsHash("#settings/nope"), { area: "settings", section: null, anchor: null, redirected: true });
  // Admin sections are not settings sections.
  assert.equal(parseSettingsHash("#settings/monitoring")?.section, null);
  for (const s of SETTINGS_SECTIONS) assert.deepEqual(parseSettingsHash(settingsHash({ area: s.area, section: s.id }))?.section, s.id);
  assert.equal(settingsHash({ area: "admin" }), "#admin");
  assert.equal(settingsHash({ area: "settings", section: "account", anchor: "passkeys" }), "#settings/account/passkeys");
});

test("every tab of the old settings and administration leads to a section", () => {
  const oldSettings = ["account", "workspace", "spaces", "members", "groups", "data", "notifications", "ai", "integrations", "time"];
  const oldAdmin = ["users", "workspaces", "operations", "instance", "ai", "audit"];
  assert.deepEqual(Object.keys(LEGACY_SECTIONS.settings).sort(), [...oldSettings].sort());
  assert.deepEqual(Object.keys(LEGACY_SECTIONS.admin).sort(), [...oldAdmin].sort());
  for (const [area, map] of Object.entries(LEGACY_SECTIONS) as ["settings" | "admin", Record<string, string>][])
    for (const [old, now] of Object.entries(map)) {
      assert.ok(findSection(area, now), `${area}/${old} → ${now} does not exist`);
      assert.equal(parseSettingsHash(`#${area}/${old}`)?.section, now);
    }
  assert.equal(parseSettingsHash("#settings/integrations")?.redirected, true);
  assert.equal(parseSettingsHash("#admin/operations")?.section, "monitoring");
});

test("search: every word in any language, accents ignored", () => {
  assert.ok(matchesQuery(["Konto & Sicherheit", "Account & security", "passwort password"], "pass"));
  assert.ok(matchesQuery(["Benachrichtigungen", "Notifications"], "notif"));
  assert.ok(matchesQuery(["Paramètres de sécurité"], "securite"));
  assert.ok(!matchesQuery(["Konto"], "konto passwort"));
  assert.ok(!matchesQuery(["Konto"], "   "));
});

test("every section is wired to a component", () => {
  // components/settings/registry.tsx names each id once in its map.
  const registry = readFileSync("components/settings/registry.tsx", "utf8");
  for (const s of SETTINGS_SECTIONS) {
    const block = registry.slice(registry.indexOf(s.area === "admin" ? "ADMIN_COMPONENTS" : "USER_COMPONENTS"));
    assert.match(block, new RegExp(`\\b${s.id}:`), `${s.area}/${s.id} has no component`);
  }
});
