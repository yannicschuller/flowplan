// Settings → Über Flowplan (lib/about.ts): the source link (FLOWPLAN_SOURCE_URL),
// the sponsor link (FLOWPLAN_HIDE_SPONSOR, never in the mobile apps) and the
// search entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GITHUB_URL, aboutInfo, hideSponsorInPage, nativeAppAgent, releaseChannel, sourceUrl, sponsorVisible } from "../lib/about";
import { SETTINGS_SECTIONS, findSection, matchesQuery } from "../lib/settings-sections";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const DESKTOP = `${BROWSER} FlowplanDesktop/1.2.0 Electron/38.0.0`;
const IOS_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.3.0";
const ANDROID_APP = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 FlowplanMobile/1.3.0";

test("the sponsor link: shown in browsers and the desktop app, hidden by FLOWPLAN_HIDE_SPONSOR", () => {
  assert.equal(sponsorVisible({}, BROWSER), true);
  assert.equal(sponsorVisible({}, DESKTOP), true);
  assert.equal(sponsorVisible({}, undefined), true);
  for (const value of ["true", "TRUE", "1", "yes", "on", " true "]) assert.equal(sponsorVisible({ FLOWPLAN_HIDE_SPONSOR: value }, BROWSER), false, value);
  for (const value of ["", "false", "0", "no", "off"]) assert.equal(sponsorVisible({ FLOWPLAN_HIDE_SPONSOR: value }, BROWSER), true, value);
});

test("the sponsor link is never shown inside the iPhone, iPad and Android apps", () => {
  assert.equal(nativeAppAgent(IOS_APP), true);
  assert.equal(nativeAppAgent(ANDROID_APP), true);
  assert.equal(nativeAppAgent(DESKTOP), false);
  assert.equal(nativeAppAgent(null), false);
  assert.equal(sponsorVisible({}, IOS_APP), false);
  assert.equal(sponsorVisible({}, ANDROID_APP), false);
  assert.equal(aboutInfo(ANDROID_APP, {}).sponsor, false);
  // The bridge of the app hides it in the page as well.
  assert.equal(hideSponsorInPage({ FlowplanApp: { platform: "ios", version: "1.3.0" } }), true);
  assert.equal(hideSponsorInPage({}), false);
  assert.equal(hideSponsorInPage(undefined), false);
});

test("hiding the sponsor link keeps licence and source", () => {
  const info = aboutInfo(IOS_APP, { FLOWPLAN_HIDE_SPONSOR: "true" });
  assert.equal(info.sponsor, false);
  assert.equal(info.sourceUrl, GITHUB_URL);
});

test("the source link: the official repository unless FLOWPLAN_SOURCE_URL names another", () => {
  assert.equal(sourceUrl({}), "https://github.com/yannicschuller/flowplan");
  assert.equal(aboutInfo(BROWSER, {}).customSource, false);
  const custom = aboutInfo(BROWSER, { FLOWPLAN_SOURCE_URL: " https://git.example.org/team/flowplan-fork/ " });
  assert.equal(custom.sourceUrl, "https://git.example.org/team/flowplan-fork");
  assert.equal(custom.customSource, true);
  // The official commit link would point to the wrong code.
  assert.equal(custom.commitUrl, "");
  // Only http(s) addresses count; anything else falls back.
  for (const bad of ["javascript:alert(1)", "git@example.org:a/b.git", "ftp://example.org", "https://exa mple.org", "https://example.org/\"onmouseover"])
    assert.equal(sourceUrl({ FLOWPLAN_SOURCE_URL: bad }), GITHUB_URL, bad);
});

test("the release channel of the image", () => {
  assert.equal(releaseChannel("beta"), "beta");
  assert.equal(releaseChannel(" Release "), "release");
  assert.equal(releaseChannel(""), "");
  assert.equal(releaseChannel(undefined), "");
  assert.equal(releaseChannel("nightly"), "");
  assert.equal(aboutInfo(BROWSER, { FLOWPLAN_CHANNEL: "beta" }).channel, "beta");
});

test("settings search finds Über Flowplan", () => {
  const about = findSection("settings", "about");
  assert.ok(about, "settings/about exists");
  assert.equal(about.group, "help");
  const texts = [about.title.de, about.title.en, about.description.de, about.keywords.de, about.keywords.en];
  for (const query of ["Über", "uber", "About", "Version", "Lizenz", "Licence", "Quellcode", "Source", "Unterstützen", "Sponsor", "AGPL", "Discord"]) assert.ok(matchesQuery(texts, query), query);
  // Entries lead to the cards of the page.
  const anchors = (about.entries || []).map((e) => e.anchor);
  for (const anchor of ["version", "licence", "bug", "support"]) assert.ok(anchors.includes(anchor), anchor);
  const entry = about.entries?.find((e) => matchesQuery([e.title.de, e.title.en, e.keywords?.de || "", e.keywords?.en || ""], "sponsor"));
  assert.equal(entry?.anchor, "support");
  // It is a settings section, not one of the administration.
  assert.equal(SETTINGS_SECTIONS.filter((s) => s.id === "about").length, 1);
});
