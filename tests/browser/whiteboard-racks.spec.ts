import { boardInsert } from "./whiteboard-ui";
import { test, expect, type Locator, type Page } from "@playwright/test";

// Rack planning on whiteboards (#187): host name, IP and MAC addresses and
// roles of a device, MAC and IP of its ports, the device's card on the
// board (hover, I, long press) and typing in the middle of the panels'
// text fields (the caret used to jump to the end after one character).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.RACK_SCREENSHOTS;
async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded", workspaceId: boot.workspace.id });
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "whiteboard" });
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-canvas")).toBeVisible();
  return wb;
}
// A rack with a server and a switch (from the device library).
async function rackWithDevices(page: Page, wb: Locator) {
  await boardInsert(wb, "Racks");
  const library = page.getByRole("dialog", { name: "Racks und Geräte" });
  await library.getByRole("button", { name: "Wandschrank 12 HE" }).click();
  await expect(wb.locator(".wb-rack")).toHaveCount(1);
  if (!(await library.isVisible())) await boardInsert(wb, "Racks");
  await library.getByRole("button", { name: /^Switch 24 Ports/ }).first().click();
  if (!(await library.isVisible())) await boardInsert(wb, "Racks");
  // The next device goes into the rack the selected switch is in.
  await library.getByRole("button", { name: /^Server 2 HE/ }).first().click();
  await expect(wb.locator(".wb-device")).toHaveCount(2);
  if (await library.isVisible()) await library.getByRole("button", { name: "Gerätebibliothek schließen" }).click();
  // Everything in view.
  await wb.focus();
  await page.keyboard.press("Shift+Digit1");
  await page.waitForTimeout(400);
}
// Types in the middle of a field's text: the caret stays where it was put
// and the text comes out right (#187).
async function typeInMiddle(page: Page, field: Locator, start: string, at: number, insert: string) {
  await field.fill(start);
  await field.blur();
  await expect(field).toHaveValue(start);
  await field.click();
  await field.evaluate((el: HTMLInputElement | HTMLTextAreaElement, at: number) => el.setSelectionRange(at, at), at);
  // A pause between the keys: each change reaches the board before the next.
  await page.keyboard.type(insert, { delay: 60 });
  const expected = start.slice(0, at) + insert + start.slice(at);
  await expect(field).toHaveValue(expected);
  expect(await field.evaluate((el: HTMLInputElement | HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([at + insert.length, at + insert.length]);
  // And it is stored: after leaving the field the board's value is shown.
  await field.blur();
  await page.waitForTimeout(100);
  await expect(field).toHaveValue(expected);
}

test("rack panels: typing in the middle of a text keeps the caret (#187)", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop details panel");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const wb = await setup(page, `Rack-Cursor ${Date.now()}`);
  await rackWithDevices(page, wb);
  const details = wb.getByRole("complementary", { name: "Details: Gerät" });
  await expect(details).toBeVisible();
  await typeInMiddle(page, details.getByLabel("Name", { exact: true }), "srv-alpha", 3, "XYZ");
  await typeInMiddle(page, details.getByLabel("Hersteller", { exact: true }), "Dell", 2, "ab");
  await typeInMiddle(page, details.getByLabel("Modell", { exact: true }), "R650", 1, "-x ");
  await typeInMiddle(page, details.getByLabel("Seriennummer", { exact: true }), "ABC123", 3, "-")
  await typeInMiddle(page, details.getByLabel("Notizen", { exact: true }), "Erste Zeile\nZweite", 5, " neue");
  await typeInMiddle(page, details.getByLabel("Hostname", { exact: true }), "srv.lan", 3, "-01");
  // Ports: name and label.
  await typeInMiddle(page, details.getByLabel("Portname").first(), "eth1", 3, "0/");
  await typeInMiddle(page, details.getByLabel("Bezeichnung", { exact: true }).first(), "Uplink", 2, "--");
  // Number fields keep what is typed on the way ("1." before "1.5").
  const weight = details.getByLabel("Gewicht");
  await weight.fill("");
  await weight.pressSequentially("12.50", { delay: 60 });
  await expect(weight).toHaveValue("12.50");
  // The rack's name and location.
  await details.locator(".wb-rack-where button").first().click();
  const rackDetails = wb.getByRole("complementary", { name: "Details: Rack" });
  await typeInMiddle(page, rackDetails.getByLabel("Name", { exact: true }), "Rack A", 4, "Haupt-");
  await typeInMiddle(page, rackDetails.getByLabel("Standort", { exact: true }), "RZ 1 Reihe B", 4, " ·");
  // A cable's label: connect a port of the server to the switch.
  await rackDetails.getByRole("button", { name: /srvXYZ-alpha/ }).click();
  await details.getByRole("button", { name: "Verbinden …" }).first().click();
  await details.getByRole("button", { name: "Verbinden", exact: true }).click();
  const cableDetails = wb.getByRole("complementary", { name: "Details: Kabel" });
  await typeInMiddle(page, cableDetails.getByLabel("Beschriftung", { exact: true }), "K-0001", 2, "A");
  await typeInMiddle(page, cableDetails.getByLabel("Notizen", { exact: true }), "Patch zu Switch", 6, "kabel ");
  expect(errors).toEqual([]);
});

test("rack panels: roles, host name, IP and MAC addresses, port addresses (#187)", async ({ page, context }, info) => {
  test.skip(info.project.name === "mobile", "Desktop details panel");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const wb = await setup(page, `Rack-Netzwerk ${Date.now()}`);
  await rackWithDevices(page, wb);
  const details = wb.getByRole("complementary", { name: "Details: Gerät" });
  await details.getByLabel("Name", { exact: true }).fill("pve-01");
  // Roles: a suggestion, a typed one (kept as typed), no doubles.
  const roles = details.getByLabel("Rollen", { exact: true });
  await roles.click();
  await roles.fill("hyper");
  await details.getByRole("button", { name: "Hypervisor" }).click();
  await roles.fill("Docker-Host");
  await roles.press("Enter");
  await roles.fill("hypervisor");
  await roles.press("Enter");
  await expect(details.locator(".wb-rack-role")).toHaveText(["Hypervisor", "Docker-Host"]);
  await details.getByRole("button", { name: "Rolle „Docker-Host“ entfernen" }).click();
  await roles.fill("Docker-Host,");
  await expect(details.locator(".wb-rack-role")).toHaveText(["Hypervisor", "Docker-Host"]);
  await details.getByLabel("Hostname", { exact: true }).fill("pve-01.lan");
  // MAC: any spelling, shown normalised once the field is left.
  const mac = details.getByLabel("MAC-Adresse", { exact: true });
  await mac.fill("AABB.CCDD.EEFF");
  await mac.blur();
  await expect(mac).toHaveValue("aa:bb:cc:dd:ee:ff");
  await mac.fill("aa:bb:cc");
  await mac.blur();
  await expect(details.getByRole("alert")).toHaveText("Keine gültige MAC-Adresse (z. B. aa:bb:cc:dd:ee:ff).");
  await expect(mac).toHaveAttribute("aria-invalid", "true");
  // The invalid text was not saved: the stored MAC is still there.
  await mac.fill("aa-bb-cc-dd-ee-ff");
  await mac.blur();
  await expect(details.getByRole("alert")).toHaveCount(0);
  await expect(mac).toHaveValue("aa:bb:cc:dd:ee:ff");
  // IP addresses: several, checked.
  const ips = details.getByLabel("IP-Adressen", { exact: true });
  await ips.fill("10.0.0.5/24, 10.0.0.999");
  await ips.blur();
  await expect(details.getByRole("alert")).toHaveText("Keine gültige IP-Adresse: 10.0.0.999");
  await ips.fill("10.0.0.5/24  2001:db8::5");
  await ips.blur();
  await expect(details.getByRole("alert")).toHaveCount(0);
  await expect(ips).toHaveValue("10.0.0.5/24, 2001:db8::5");
  // A network port has a MAC and an IP of its own; power ports have none.
  const portMac = details.getByLabel("MAC-Adresse von eth1");
  await portMac.fill("00-11-22-33-44-55");
  await portMac.blur();
  await expect(portMac).toHaveValue("00:11:22:33:44:55");
  await details.getByLabel("IP-Adresse von eth1").fill("10.0.0.6/24");
  await expect(details.getByLabel(/^MAC-Adresse von PSU/)).toHaveCount(0);
  await details.getByLabel("Hersteller", { exact: true }).fill("Dell");
  await details.getByLabel("Modell", { exact: true }).fill("PowerEdge R650");
  await details.getByLabel("Notizen", { exact: true }).fill("Proxmox-Cluster, Knoten 1 – bitte vor Wartung die VMs verschieben.");
  if (shots) {
    await details.locator(".wb-rack-form").evaluate((el) => (el.scrollTop = 0));
    await details.screenshot({ path: `${shots}/187-device-panel.png` });
  }
  if (shots) await page.screenshot({ path: `${shots}/187-device-panel-board.png` });

  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  // The card: after resting on the device with the mouse.
  const server = wb.locator(".wb-device").nth(1);
  const box = (await server.boundingBox())!;
  const rackBox = (await wb.locator(".wb-rack").boundingBox())!;
  const away = { x: rackBox.x - 80, y: rackBox.y + rackBox.height / 2 };
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width * 0.22, box.y + box.height / 2, { steps: 3 });
  const card = page.getByRole("dialog", { name: "Visitenkarte: pve-01" });
  await expect(card).toBeVisible();
  await expect(card.locator(".wb-device-card-roles li")).toHaveText(["Hypervisor", "Docker-Host"]);
  await expect(card).toContainText("pve-01.lan");
  await expect(card).toContainText("10.0.0.5/24");
  await expect(card).toContainText("2001:db8::5");
  await expect(card).toContainText("aa:bb:cc:dd:ee:ff");
  await expect(card).toContainText("2 HE");
  await expect(card).toContainText("Proxmox-Cluster");
  // Beside the device, inside the window.
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x >= box.x + box.width || cardBox.x + cardBox.width <= box.x).toBe(true);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(1000);
  if (shots) await page.screenshot({ path: `${shots}/187-hover-card.png` });
  // It stays while the pointer is on it; copying an address.
  await card.getByRole("button", { name: "IP-Adresse 10.0.0.5/24 kopieren" }).hover();
  await card.getByRole("button", { name: "IP-Adresse 10.0.0.5/24 kopieren" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("10.0.0.5/24");
  // Leaving the card and the device closes it.
  await page.mouse.move(away.x, away.y, { steps: 4 });
  await expect(card).toHaveCount(0);
  // A press on the device (as for dragging) shows no card.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2 + 2, box.y + box.height / 2 + 1, { steps: 3 });
  await page.waitForTimeout(900);
  await expect(card).toHaveCount(0);
  await page.mouse.up();
  // With another tool (connecting) no card either.
  await page.mouse.move(away.x, away.y);
  await wb.focus();
  await page.keyboard.press("l");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 3 });
  await page.waitForTimeout(900);
  await expect(card).toHaveCount(0);
  await page.keyboard.press("v");
  // Keyboard: I on the selected device opens it with the focus inside,
  // Escape closes it and gives the focus back to the board.
  await page.mouse.move(away.x, away.y);
  await server.click({ position: { x: 20, y: 10 } });
  await wb.focus();
  await page.keyboard.press("i");
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(wb).toBeFocused();

  // Dark mode and the port list.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.keyboard.press("i");
  await expect(card).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/187-hover-card-dark.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(details).toBeVisible();
  if (shots) {
    await details.locator(".wb-rack-form").evaluate((el) => (el.scrollTop = 0));
    await details.screenshot({ path: `${shots}/187-device-panel-dark.png` });
  }
  // The ports overview shows the port's addresses and finds them.
  await page.emulateMedia({ colorScheme: "light" });
  await boardInsert(wb, "Racks");
  await page.getByRole("dialog", { name: "Racks und Geräte" }).getByRole("button", { name: "Ports und Kabel" }).click();
  const overview = page.getByRole("dialog", { name: "Ports und Kabel" });
  await overview.getByRole("searchbox", { name: "Filtern" }).fill("10.0.0.6");
  await expect(overview.locator("tbody tr")).toHaveCount(1);
  await expect(overview.locator("tbody tr")).toContainText("eth1");
  await expect(overview.locator("tbody tr")).toContainText("10.0.0.6/24 · 00:11:22:33:44:55");
  expect(errors).toEqual([]);
});

test("rack card: a long press on a device opens it on touch screens (#187)", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch");
  const wb = await setup(page, `Rack-Touch ${Date.now()}`);
  await rackWithDevices(page, wb);
  const server = wb.locator(".wb-device").nth(1);
  const box = (await server.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const at = { x: box.x + Math.min(30, box.width / 4), y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const card = page.getByRole("dialog", { name: /^Visitenkarte: / });
  await expect(card).toBeVisible();
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x).toBeGreaterThanOrEqual(0);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(390);
  await card.getByRole("button", { name: "Schließen" }).click();
  await expect(card).toHaveCount(0);
  // A short tap only selects.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.waitForTimeout(80);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(800);
  await expect(card).toHaveCount(0);
});
