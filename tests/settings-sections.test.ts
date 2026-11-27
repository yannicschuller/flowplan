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
  redirectedSettingsHash,
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
  assert.deepEqual(parseSettingsHash("#settings/instance/users"), { area: "admin", section: "users", anchor: null, redirected: false });
  assert.deepEqual(parseSettingsHash("#settings/instance"), { area: "admin", section: null, anchor: null, redirected: false });
  assert.deepEqual(parseSettingsHash("#settings/account/passkeys"), { area: "settings", section: "account", anchor: "passkeys", redirected: false });
  assert.equal(parseSettingsHash("#home"), null);
  assert.equal(parseSettingsHash("#page=abc"), null);
  // Unknown sections open the landing page.
  assert.deepEqual(parseSettingsHash("#settings/nope"), { area: "settings", section: null, anchor: null, redirected: true });
  // Admin sections are not settings sections.
  assert.equal(parseSettingsHash("#settings/monitoring")?.section, null);
  for (const s of SETTINGS_SECTIONS) assert.deepEqual(parseSettingsHash(settingsHash({ area: s.area, section: s.id }))?.section, s.id);
  assert.equal(settingsHash({ area: "admin" }), "#settings/instance");
  assert.equal(settingsHash({ area: "admin", section: "ai", anchor: "quotas" }), "#settings/instance/ai/quotas");
  assert.equal(settingsHash({ area: "settings", section: "account", anchor: "passkeys" }), "#settings/account/passkeys");
});

// #532: settings and administration are one screen; the instance's
// sections have their own addresses, the old ones lead there.
test("the administration's old addresses lead to the instance part of the settings", () => {
  assert.deepEqual(parseSettingsHash("#admin"), { area: "admin", section: null, anchor: null, redirected: true });
  assert.deepEqual(parseSettingsHash("#admin/users"), { area: "admin", section: "users", anchor: null, redirected: true });
  assert.equal(redirectedSettingsHash("#admin"), "#settings/instance");
  assert.equal(redirectedSettingsHash("#admin/monitoring/errors"), "#settings/instance/monitoring/errors");
  assert.equal(redirectedSettingsHash("#admin/operations"), "#settings/instance/monitoring");
  assert.equal(redirectedSettingsHash("#admin/threats/incident/abc"), "#settings/instance/threats/incident/abc");
  assert.equal(redirectedSettingsHash("#settings/instance/threats/incident/abc"), null);
  assert.equal(redirectedSettingsHash("#settings/account"), null);
  assert.equal(redirectedSettingsHash("#home"), null);
  // The ids both areas have (ai, security, extensions) stay apart.
  for (const id of ["ai", "security", "extensions"]) {
    assert.equal(parseSettingsHash(`#settings/${id}`)?.area, "settings");
    assert.equal(parseSettingsHash(`#settings/instance/${id}`)?.area, "admin");
    assert.equal(parseSettingsHash(`#settings/instance/${id}`)?.section, id);
  }
  // "instance" is no personal section (it is the instance's address).
  assert.equal(findSection("settings", "instance"), null);
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
      assert.equal(parseSettingsHash(`${settingsHash({ area })}/${old}`)?.section, now);
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

test("search targets of the personal and connection sections exist in their panels", () => {
  // Each anchor is the id of a card (SettingGroup id), a row (SettingRow
  // anchor) or an element of the panel; "new" is the page of a new webhook.
  const sources = [
    "components/settings/user/account.tsx",
    "components/account-security.tsx",
    "components/sign-in-methods.tsx",
    "components/two-factor.tsx",
    "components/my-sessions.tsx",
    "components/e2ee.tsx",
    "components/emergency-access.tsx",
    "components/dead-man-switch.tsx",
    "components/notification-settings.tsx",
    "components/notification-sound-settings.tsx",
    "components/messenger-settings.tsx",
    "components/weekly-digest-settings.tsx",
    "components/push-settings.tsx",
    "components/offline-settings.tsx",
    "components/integration-settings.tsx",
    "components/calendar-connections.tsx",
    "components/caldav-profile.tsx",
    "components/issue-sync-settings.tsx",
    "components/clipper-settings.tsx",
    "components/capture-target.tsx",
    "components/settings/user/about.tsx",
    "components/settings/user/appearance.tsx",
    "components/settings/user/toolbar-layout-editor.tsx",
    "components/settings/user/feature-modules.tsx",
    "components/settings/user/sidebar-tools-settings.tsx",
    "components/settings/user/usage.tsx",
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  for (const id of ["usage", "account", "appearance", "notifications", "devices", "api", "connections", "clipper", "about"])
    for (const entry of findSection("settings", id)?.entries || [])
      if (entry.anchor) assert.match(sources, new RegExp(`(id|anchor)="${entry.anchor}"`), `settings/${id}/${entry.anchor} has no target`);
  assert.equal(parseSettingsHash("#settings/webhooks/new")?.anchor, "new");
});

test("search targets of the limits section exist in its panel", () => {
  // Administration → Grenzen & Aufbewahrung, with the workflow limits (#168)
  // and the export / import of the limits.
  const sources = ["components/settings/admin/limits.tsx", "components/settings/admin/workflow-limits.tsx", "components/settings/admin/limits-file.tsx"].map((file) => readFileSync(file, "utf8")).join("\n");
  const entries = findSection("admin", "limits")?.entries || [];
  assert.ok(entries.some((e) => e.anchor === "workflows"));
  for (const entry of entries) if (entry.anchor) assert.match(sources, new RegExp(`id="${entry.anchor}"`), `admin/limits/${entry.anchor} has no target`);
});
