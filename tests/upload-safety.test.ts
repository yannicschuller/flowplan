import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeFileName, stripLocation, verifiedMime, requireBodySize } from "../lib/upload-safety";

// A minimal JPEG with an EXIF block: IFD0 points to a GPS directory with a
// latitude (three rationals stored outside the entry).
function jpegWithGps() {
  const tiff = Buffer.alloc(80);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 at 8
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x8825, 10); // GPSInfo
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18); // GPS IFD at 26
  tiff.writeUInt16LE(1, 26); // one GPS entry
  tiff.writeUInt16LE(2, 28); // GPSLatitude
  tiff.writeUInt16LE(5, 30); // RATIONAL
  tiff.writeUInt32LE(3, 32); // three of them
  tiff.writeUInt32LE(44, 36); // data at 44
  for (let i = 0; i < 6; i++) tiff.writeUInt32LE([52, 1, 31, 1, 12, 1][i], 44 + i * 4);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, exif.length + 2]), exif]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])]);
}

test("photos lose their GPS position, the rest of the file stays", () => {
  const original = jpegWithGps();
  const latitude = Buffer.alloc(4);
  latitude.writeUInt32LE(52);
  assert.ok(original.includes(latitude));
  const cleaned = stripLocation(original, "image/jpeg");
  assert.equal(cleaned.length, original.length);
  assert.ok(!cleaned.includes(Buffer.from([52, 0, 0, 0, 1, 0, 0, 0, 31])));
  // Image data after the start of scan is unchanged.
  assert.deepEqual(cleaned.subarray(-9), original.subarray(-9));
  // XMP (which can repeat the position) is dropped.
  const xmp = Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude='52'/>", "latin1");
  const withXmp = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, xmp.length + 2]), xmp, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
  assert.ok(!stripLocation(withXmp, "image/jpeg").toString("latin1").includes("GPSLatitude"));
  // Other types and broken files stay as they are.
  assert.deepEqual(stripLocation(Buffer.from("hello"), "image/jpeg"), Buffer.from("hello"));
});

test("the stored type has to match the content", () => {
  const png = Buffer.from("89504e470d0a1a0a0000", "hex");
  assert.equal(verifiedMime("image/png", png), "image/png");
  assert.equal(verifiedMime("image/png", Buffer.from("<html><script>")), "application/octet-stream");
  assert.equal(verifiedMime("text/html", Buffer.from("<html>")), "application/octet-stream");
  assert.equal(verifiedMime("image/svg+xml", Buffer.from("<svg>")), "application/octet-stream");
  assert.equal(verifiedMime("", Buffer.from("x")), "application/octet-stream");
  assert.equal(verifiedMime("text/plain", Buffer.from("x")), "text/plain");
});

test("file names and request sizes", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeFileName("..\\boot.ini"), "boot.ini");
  assert.equal(sanitizeFileName("a\u0000b\nc.txt"), "abc.txt");
  assert.equal(sanitizeFileName("   "), "datei");
  const req = (headers: Record<string, string>) => new Request("http://x/", { method: "POST", headers });
  assert.throws(() => requireBodySize(req({}), 100, "zu groß"), /Größe der Anfrage fehlt/);
  assert.throws(() => requireBodySize(req({ "content-length": "500" }), 100, "zu groß"), /zu groß/);
  assert.doesNotThrow(() => requireBodySize(req({ "content-length": "50" }), 100, "zu groß"));
});
