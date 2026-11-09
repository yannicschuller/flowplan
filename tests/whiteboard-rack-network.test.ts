// Network details of rack devices (#187): host name, IP and MAC addresses
// and roles of a device, MAC and IP of its network ports – checking, the
// text and Markdown of a board, search, the drawing's tooltip, the JSON
// round trip and what the NetBox import brings along.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WhiteboardItem } from "../lib/whiteboard-model";
import { itemText } from "../lib/whiteboard-model";
import {
  applyRackLayout,
  cleanDevice,
  cleanIp,
  cleanPort,
  cleanRoles,
  deviceSummary,
  MAX_IPS,
  MAX_ROLES,
  normalizeMac,
  parseIps,
  parseRacksJson,
  portRows,
  racksJson,
  racksMarkdown,
  racksText,
  type DeviceData,
} from "../lib/whiteboard-rack";
import { fetchNetbox } from "../lib/whiteboard-rack-server";
import { netboxIps, netboxRoles, netboxToRacks } from "../lib/whiteboard-rack-netbox";
import { deviceSvg, rackContext } from "../lib/whiteboard-rack-svg";
import { cardPosition } from "../components/whiteboard/rack-card";

const t = (de: string) => de;
const en = (_de: string, en: string) => en;
const host: DeviceData = {
  kind: "server",
  height: 2,
  hostname: "pve-01.lan",
  ips: ["10.0.0.5/24", "2001:db8::5"],
  mac: "aa:bb:cc:dd:ee:ff",
  roles: ["Hypervisor", "Docker-Host"],
  manufacturer: "Dell",
  model: "R650",
  powerW: 400,
  notes: "Proxmox-Cluster, Knoten 1",
  ports: [
    { id: "p1", name: "eno1", type: "rj45", face: "rear", mac: "aa:bb:cc:dd:ee:01", ip: "10.0.0.5/24" },
    { id: "p2", name: "PSU1", type: "c14", face: "rear" },
  ],
};
const items = (): WhiteboardItem[] =>
  applyRackLayout([
    { id: "r", type: "rack", x: 0, y: 0, w: 0, h: 0, z: -1, text: "R1", rack: { u: 12, width: 19, face: "rear" } } as WhiteboardItem,
    { id: "d", type: "device", x: 0, y: 0, w: 0, h: 0, z: 1, text: "pve-01", rackId: "r", u: 3, device: host } as WhiteboardItem,
  ]);

test("IP addresses: IPv4 and IPv6, optionally with a prefix length", () => {
  for (const ok of ["10.0.0.5", "192.168.1.254/24", "0.0.0.0/0", "255.255.255.255/32", "2001:db8::1", "2001:db8::1/64", "::1", "::", "fe80::1:2:3:4", "1:2:3:4:5:6:7:8", "::ffff:192.0.2.1", "2001:DB8::A/128", " 10.1.2.3 "])
    assert.ok(cleanIp(ok), ok);
  for (const bad of ["", "10.0.0", "10.0.0.256", "10.0.0.5/33", "01.2.3.4", "1.2.3.4/", "1.2.3.4/24/1", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "2001:db8::g", "2001:db8::1/129", "::ffff:300.0.0.1", "host.lan", "1.2.3.4 5.6.7.8", 42])
    assert.equal(cleanIp(bad), null, String(bad));
  assert.equal(cleanIp(" 10.1.2.3 "), "10.1.2.3");
  assert.deepEqual(parseIps("10.0.0.5/24, 2001:db8::5\n10.0.0.5/24; 10.0.0.6"), { ips: ["10.0.0.5/24", "2001:db8::5", "10.0.0.6"], invalid: [], tooMany: false });
  assert.deepEqual(parseIps("10.0.0.5, 10.0.0.").invalid, ["10.0.0."]);
  assert.deepEqual(parseIps("").ips, []);
  const many = parseIps(Array.from({ length: MAX_IPS + 2 }, (_, i) => `10.0.0.${i + 1}`).join(" "));
  assert.equal(many.ips.length, MAX_IPS);
  assert.equal(many.tooMany, true);
});

test("MAC addresses: every usual spelling becomes aa:bb:cc:dd:ee:ff", () => {
  for (const raw of ["aa:bb:cc:dd:ee:ff", "AA:BB:CC:DD:EE:FF", "aa-bb-cc-dd-ee-ff", "aabb.ccdd.eeff", "AABBCCDDEEFF", " aa:bb:cc:dd:ee:ff "]) assert.equal(normalizeMac(raw), "aa:bb:cc:dd:ee:ff", raw);
  for (const bad of ["", "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:fg", "aa:bb-cc:dd:ee:ff", "aabb.ccdd.ee", "aa:bb:cc:dd:ee:ff:00", null, 12]) assert.equal(normalizeMac(bad), null, String(bad));
});

test("roles: free tags, trimmed, no doubles, kept as typed", () => {
  assert.deepEqual(cleanRoles(["  Docker-Host ", "hypervisor", "Hypervisor", "", 3, "Bare  Metal"]), ["Docker-Host", "hypervisor", "Bare Metal"]);
  assert.equal(cleanRoles([]), undefined);
  assert.equal(cleanRoles("NAS"), undefined);
  assert.equal(cleanRoles(Array.from({ length: 20 }, (_, i) => `r${i}`))!.length, MAX_ROLES);
  assert.equal(cleanRoles(["x".repeat(100)])![0].length, 40);
});

test("checking: device and port network fields from clients", () => {
  const d = cleanDevice({
    kind: "server",
    height: 1,
    hostname: "h".repeat(300),
    ips: ["10.0.0.1", "nope", "10.0.0.1", "2001:db8::1/64", 5],
    mac: "AA-BB-CC-DD-EE-FF",
    roles: ["NAS", "nas"],
    ports: [
      { id: "p1", name: "eth0", type: "rj45", face: "rear", mac: "0011.2233.4455", ip: "192.168.0.10/24" },
      { id: "p2", name: "eth1", type: "sfp28", face: "rear", mac: "bad", ip: "300.1.1.1" },
      // Power, console and patch connectors have no MAC or IP.
      { id: "p3", name: "PSU", type: "c14", face: "rear", mac: "00:11:22:33:44:55", ip: "10.0.0.9" },
      { id: "p4", name: "CON", type: "console", face: "front", mac: "00:11:22:33:44:55" },
      { id: "p5", name: "1", type: "lc", face: "front", ip: "10.0.0.9" },
    ],
  })!;
  assert.equal(d.hostname!.length, 253);
  assert.deepEqual(d.ips, ["10.0.0.1", "2001:db8::1/64"]);
  assert.equal(d.mac, "aa:bb:cc:dd:ee:ff");
  assert.deepEqual(d.roles, ["NAS"]);
  assert.deepEqual(d.ports[0], { id: "p1", name: "eth0", type: "rj45", face: "rear", mac: "00:11:22:33:44:55", ip: "192.168.0.10/24" });
  assert.deepEqual(d.ports[1], { id: "p2", name: "eth1", type: "sfp28", face: "rear" });
  for (const p of d.ports.slice(2)) assert.ok(!("mac" in p) && !("ip" in p), p.name);
  const empty = cleanDevice({ kind: "server", height: 1, ips: [], roles: [], mac: "", hostname: "  ", ports: [] })!;
  assert.deepEqual(Object.keys(empty).sort(), ["height", "kind", "ports"]);
  assert.equal(cleanPort({ id: "p", name: "x", type: "qsfp28", face: "front", ip: "::1" })!.ip, "::1");
});

test("text: the device summary, AI text, Markdown, port rows and search", () => {
  const board = items();
  const d = board.find((i) => i.id === "d")!;
  assert.equal(
    deviceSummary(d, en),
    'pve-01 (U3–4): Server (Hypervisor, Docker-Host), host name pve-01.lan, IP 10.0.0.5/24, 2001:db8::5, MAC aa:bb:cc:dd:ee:ff, Dell R650, 400 W, ports: eno1 RJ45 10.0.0.5/24 aa:bb:cc:dd:ee:01, PSU1 C14',
  );
  assert.ok(racksText(board, t).includes("- pve-01 (U3–4): Server (Hypervisor, Docker-Host), Hostname pve-01.lan, IP 10.0.0.5/24, 2001:db8::5, MAC aa:bb:cc:dd:ee:ff"));
  const md = racksMarkdown(board, en, (s) => s.replaceAll("|", "\\|"));
  assert.ok(md.includes("| U | Device | Kind | Network | Model | Power | Weight |"), md);
  assert.ok(md.includes("| U3–4 | pve-01 | Server (Hypervisor, Docker-Host) | pve-01.lan · 10.0.0.5/24 · 2001:db8::5 · aa:bb:cc:dd:ee:ff | Dell R650 | 400 W |"), md);
  // A port with only an address is listed in the port assignments.
  assert.ok(md.includes("| pve-01 | eno1 | RJ45 |   |   |   | 10.0.0.5/24 · aa:bb:cc:dd:ee:01 |"), md);
  const rows = portRows(board, en);
  assert.deepEqual([rows[0].mac, rows[0].ip, rows[1].mac, rows[1].ip], ["aa:bb:cc:dd:ee:01", "10.0.0.5/24", "", ""]);
  const text = itemText(d);
  for (const word of ["pve-01.lan", "10.0.0.5/24", "2001:db8::5", "aa:bb:cc:dd:ee:ff", "Hypervisor", "Docker-Host", "aa:bb:cc:dd:ee:01"]) assert.ok(text.includes(word), word);
});

test("drawing: the exported tooltip names roles and addresses, the board's has none", () => {
  const board = items();
  const d = board.find((i) => i.id === "d")!;
  const map = new Map(board.map((i) => [i.id, i]));
  const svg = deviceSvg(d, map, rackContext(board), en);
  assert.match(svg, /<title>pve-01 · Hypervisor, Docker-Host · pve-01\.lan · 10\.0\.0\.5\/24 · 2001:db8::5 · Dell R650/);
  assert.match(svg, /<title>pve-01 · eno1 · RJ45 · 10\.0\.0\.5\/24 · aa:bb:cc:dd:ee:01<\/title>/);
  const onBoard = deviceSvg(d, map, rackContext(board), en, { title: false });
  assert.doesNotMatch(onBoard, /<title>pve-01 · Hypervisor/);
  // Port titles stay (they name the port under the pointer).
  assert.match(onBoard, /<title>pve-01 · eno1/);
});

test("JSON: export and import keep the network fields", () => {
  const json = JSON.parse(JSON.stringify(racksJson(items())));
  const drafts = parseRacksJson(json);
  const d = drafts.find((x) => x.type === "device")!.device!;
  assert.deepEqual([d.hostname, d.ips, d.mac, d.roles, d.ports[0].mac, d.ports[0].ip], ["pve-01.lan", ["10.0.0.5/24", "2001:db8::5"], "aa:bb:cc:dd:ee:ff", ["Hypervisor", "Docker-Host"], "aa:bb:cc:dd:ee:01", "10.0.0.5/24"]);
});

test("NetBox: primary IPs, DNS name, interface MACs and IPs, role and tags", () => {
  const device = {
    id: 12,
    name: "esx-1",
    device_type: { id: 2 },
    role: { slug: "server", name: "Hypervisor" },
    tags: [{ name: "Produktion" }, { name: "hypervisor" }, { slug: "only-slug" }],
    rack: { id: 7 },
    position: 20,
    primary_ip4: { id: 501, address: "10.0.0.12/24", dns_name: "esx-1.lan" },
    primary_ip6: { id: 502, address: "2001:db8::12/64" },
    oob_ip: { id: 503, address: "10.9.0.12/24" },
  };
  assert.deepEqual(netboxIps(device), ["10.0.0.12/24", "2001:db8::12/64", "10.9.0.12/24"]);
  assert.deepEqual(netboxRoles(device), ["Hypervisor", "Produktion"]);
  assert.deepEqual(netboxIps({ id: 1, primary_ip4: { address: "not an ip" } }), []);
  const result = netboxToRacks({
    racks: [{ id: 7, name: "R-07", u_height: 42 }],
    deviceTypes: [{ id: 2, model: "R650", manufacturer: { name: "Dell" }, u_height: 1 }],
    devices: [device, { id: 13, name: "plain", device_type: { id: 2 }, rack: { id: 7 }, position: 10 }],
    interfaces: [
      { id: 199, device: { id: 12 }, name: "idrac", type: { value: "1000base-t" }, mgmt_only: true, mac_address: "00:11:22:33:44:00" },
      // NetBox 4.2+: the MAC is an object of its own.
      { id: 200, device: { id: 12 }, name: "eno1", type: { value: "1000base-t" }, primary_mac_address: { mac_address: "00:11:22:33:44:01" } },
      { id: 201, device: { id: 12 }, name: "eno2", type: { value: "10gbase-x-sfpp" }, mac_address: "00-11-22-33-44-02" },
      { id: 300, device: { id: 13 }, name: "eth0", type: { value: "1000base-t" }, mac_address: "AA:BB:CC:00:00:01" },
    ],
    frontPorts: [],
    rearPorts: [],
    consolePorts: [],
    powerPorts: [],
    powerOutlets: [],
    cables: [],
    ipAddresses: [
      { id: 501, address: "10.0.0.12/24", assigned_object_type: "dcim.interface", assigned_object_id: 201 },
      { id: 504, address: "192.168.5.1/24", assigned_object_type: "dcim.interface", assigned_object_id: 200 },
      { id: 505, address: "fe80::1/64", assigned_object_type: "virtualization.vminterface", assigned_object_id: 200 },
    ],
  });
  const esx = result.devices[0];
  assert.equal(esx.hostname, "esx-1.lan");
  assert.deepEqual(esx.ips, ["10.0.0.12/24", "2001:db8::12/64", "10.9.0.12/24"]);
  assert.deepEqual(esx.roles, ["Hypervisor", "Produktion"]);
  // The interface with the primary IP gives the device its MAC.
  assert.equal(esx.mac, "00:11:22:33:44:02");
  assert.deepEqual(
    esx.ports.map((p) => [p.name, "mac" in p ? p.mac : undefined, "ip" in p ? p.ip : undefined]),
    [
      ["idrac", "00:11:22:33:44:00", undefined],
      ["eno1", "00:11:22:33:44:01", "192.168.5.1/24"],
      ["eno2", "00:11:22:33:44:02", "10.0.0.12/24"],
    ],
  );
  const plain = result.devices[1];
  assert.equal(plain.mac, "aa:bb:cc:00:00:01");
  assert.ok(!("hostname" in plain) && !("ips" in plain) && !("roles" in plain));
  // Through the board's import, like a JSON file.
  const d = parseRacksJson(result).find((x) => x.type === "device")!.device!;
  assert.deepEqual([d.hostname, d.mac, d.roles], ["esx-1.lan", "00:11:22:33:44:02", ["Hypervisor", "Produktion"]]);
});

test("NetBox: IP addresses are fetched, a token without IPAM access still imports", async () => {
  const urls: string[] = [];
  const body = (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("dcim/racks/")) return { results: [{ id: 1, name: "R1", u_height: 10 }] };
    if (u.pathname.endsWith("dcim/devices/")) return { results: [{ id: 5, name: "d", rack: { id: 1 }, position: 1, device_type: { id: 3 } }] };
    if (u.pathname.endsWith("ipam/ip-addresses/")) return { results: [{ id: 9, address: "10.0.0.1/24", assigned_object_type: "dcim.interface", assigned_object_id: 1 }] };
    return { results: [] };
  };
  const data = await fetchNetbox({ url: "https://nb.example", token: "0123456789abcdef" }, async (url) => (urls.push(url), { status: 200, body: JSON.stringify(body(url)) }));
  assert.ok(urls.some((u) => u.includes("ipam/ip-addresses/?device_id=5")));
  assert.equal(data.ipAddresses?.[0].address, "10.0.0.1/24");
  const denied = await fetchNetbox({ url: "https://nb.example", token: "0123456789abcdef" }, async (url) =>
    url.includes("ipam/") ? { status: 403, body: "" } : { status: 200, body: JSON.stringify(body(url)) },
  );
  assert.deepEqual(denied.ipAddresses, []);
  assert.equal(denied.devices.length, 1);
});

test("card: placed beside the device inside the window, start side first", () => {
  const view = { w: 1000, h: 700 },
    card = { w: 300, h: 260 };
  // Room on the right.
  assert.deepEqual(cardPosition({ left: 100, top: 100, right: 340, bottom: 144 }, card, view), { left: 350, top: 100, side: "right" });
  // Right-to-left: the left first.
  assert.deepEqual(cardPosition({ left: 400, top: 100, right: 640, bottom: 144 }, card, view, true), { left: 90, top: 100, side: "left" });
  // No room on the right: the left.
  assert.equal(cardPosition({ left: 600, top: 100, right: 900, bottom: 144 }, card, view).side, "left");
  // Low on the screen: moved up so it stays inside.
  assert.equal(cardPosition({ left: 100, top: 650, right: 340, bottom: 680 }, card, view).top, 700 - 260 - 8);
  // A device as wide as the window: below it, or above when there is no room.
  assert.deepEqual(cardPosition({ left: 0, top: 50, right: 1000, bottom: 90 }, card, view), { left: 8, top: 100, side: "below" });
  assert.equal(cardPosition({ left: 0, top: 500, right: 1000, bottom: 690 }, card, view).side, "above");
});

test("library templates leave out the addresses of one machine", async () => {
  const { withoutAddresses } = await import("../lib/whiteboard-rack");
  const t = withoutAddresses(host);
  assert.deepEqual([t.hostname, t.ips, t.mac], [undefined, undefined, undefined]);
  assert.ok(!("hostname" in t) && !("mac" in t.ports[0]) && !("ip" in t.ports[0]));
  assert.deepEqual(t.roles, ["Hypervisor", "Docker-Host"]);
  assert.equal(t.model, "R650");
});
