import { nowText } from "../lib/db-driver/dialect";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-banners-"));
const { id, run } = await import("../lib/db");
const { adminGroup } = await import("../lib/auth");
const { bannersFor, deleteBanner, dismissBanner, listBanners, safeBannerLink, saveBanner, showBannerAgain } = await import("../lib/instance-banners");

const person = async (isAdmin = false): Promise<Identity> => {
  const userId = id();
  await run("INSERT INTO users(id,subject,email,name,created_at) VALUES(?,?,?,?,?)", userId, `s-${userId}`, `${userId}@example.test`, "Mia", nowText());
  return { id: userId, name: "Mia", email: "", groups: isAdmin ? [adminGroup()] : [], isAdmin, disabled: 0, created_at: "" };
};
const T = Date.UTC(2026, 9, 30, 12, 0, 0);
const H = 3_600_000;

test("banners: shown until closed, per person; links are checked", async () => {
  const admin = await person(true);
  const mia = await person();
  const ben = await person();
  const bannerId = await saveBanner(admin, { message: "Die App ist da", linkUrl: "https://flowplan.org/download", linkLabel: "Ansehen", tone: "promo" }, T);
  assert.deepEqual((await bannersFor(mia, T)).map((b) => b.id), [bannerId]);
  await dismissBanner(mia, bannerId, true, T);
  assert.equal((await bannersFor(mia, T)).length, 0, "closed: never again");
  assert.equal((await bannersFor(ben, T)).length, 1, "others still see it");
  await dismissBanner(ben, bannerId, false, T);
  const listed = (await listBanners(admin, T)).find((b) => b.id === bannerId)!;
  assert.deepEqual([listed.closed, listed.clicked, listed.state], [2, 1, "active"]);
  // Shown again: everyone sees it once more.
  await showBannerAgain(admin, bannerId);
  assert.equal((await bannersFor(mia, T)).length, 1);
  await deleteBanner(admin, bannerId);
  assert.equal((await bannersFor(mia, T)).length, 0);
  await assert.rejects(async () => await saveBanner(admin, { message: "x", linkUrl: "javascript:alert(1)" }, T), /Link/);
  assert.equal(safeBannerLink("#page=abc"), "#page=abc");
  assert.equal(safeBannerLink("//evil.example"), undefined);
  await assert.rejects(async () => await saveBanner(mia, { message: "x" }, T), /Administrator/);
});

test("banners: time window, pause and audience", async () => {
  const admin = await person(true);
  const mia = await person();
  const later = await saveBanner(admin, { message: "Morgen", startsAt: T + H, endsAt: T + 5 * H }, T);
  const admins = await saveBanner(admin, { message: "Nur Admins", audience: "admins" }, T);
  assert.ok(!(await bannersFor(mia, T)).some((b) => b.id === later), "not before its start");
  assert.ok((await bannersFor(mia, T + 2 * H)).some((b) => b.id === later));
  assert.ok(!(await bannersFor(mia, T + 6 * H)).some((b) => b.id === later), "not after its end");
  assert.ok(!(await bannersFor(mia, T)).some((b) => b.id === admins));
  assert.ok((await bannersFor(admin, T)).some((b) => b.id === admins));
  await saveBanner(admin, { id: admins, message: "Nur Admins", audience: "admins", paused: true }, T);
  assert.ok(!(await bannersFor(admin, T)).some((b) => b.id === admins), "paused");
  assert.equal((await listBanners(admin, T)).find((b) => b.id === admins)!.state, "paused");
  assert.equal((await bannersFor({ ...mia, apiScope: "read" }, T)).length, 0, "not for API tokens");
  await assert.rejects(async () => await saveBanner(admin, { message: "x", startsAt: T + 2 * H, endsAt: T + H }, T), /Ende/);
});
