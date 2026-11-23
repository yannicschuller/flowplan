// Uploads of up to 10 GB (POST /api/upload): the multipart body is read as
// a stream (lib/multipart-stream.ts) and the file goes to disk as it
// arrives; idempotency keys hash large bodies on the way
// (lib/idempotency.ts); large files go into the bucket as multipart uploads
// and come back streamed (lib/storage.ts); photos lose their location on
// disk (stripLocationFile). Memory stays flat whatever the size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeS3 } from "./helpers/fake-s3";

const dir = mkdtempSync(join(tmpdir(), "flowplan-upload-streaming-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const s3 = await startFakeS3();
process.env.S3_ENDPOINT = s3.endpoint;
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY_ID = "key";
process.env.S3_SECRET_ACCESS_KEY = "secret";

const { readMultipartStream, sweepIncoming, incomingDir, HEAD_BYTES } = await import("../lib/multipart-stream");
const { streamedHash } = await import("../lib/idempotency");
const { stripLocation, stripLocationFile } = await import("../lib/upload-safety");
const { putObject, ensureLocal, storageConfig, uploadsDir, PART_BYTES, SINGLE_PUT_BYTES } = await import("../lib/storage");
const { HttpError } = await import("../lib/auth");
const { MAX_UPLOAD_MB, IN_MEMORY_FILE_MB } = await import("../lib/upload-limit");
const { instanceSettingsSchema } = await import("../lib/instance-settings");
const { userLimitsSchema } = await import("../lib/user-limits");
const { importLimitMb } = await import("../lib/importers/upload");

const uploads = join(dir, "uploads");
const boundary = "----flowplanTestBoundary7MA4YWxkTrZu0gW";
const enc = (s: string) => Buffer.from(s, "utf8");

// A body cut into chunks of the given sizes (cycled), as a web stream.
function chunked(data: Buffer, sizes: number[]) {
  let at = 0,
    i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= data.length) return controller.close();
      const n = sizes[i++ % sizes.length];
      controller.enqueue(new Uint8Array(data.subarray(at, at + n)));
      at += n;
    },
  });
}
const form = (parts: { name: string; value?: string; filename?: string; type?: string; data?: Buffer }[]) =>
  Buffer.concat([
    ...parts.flatMap((p) => [
      enc(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ""}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ""}\r\n`),
      p.data ?? enc(p.value ?? ""),
      enc("\r\n"),
    ]),
    enc(`--${boundary}--\r\n`),
  ]);
const contentType = `multipart/form-data; boundary=${boundary}`;
const options = (max = 1024 * 1024 * 1024) => ({ uploads, maxFileBytes: max, tooLarge: () => new HttpError(413, "too large") });

test("the multipart reader gives the fields and the file, whatever the chunks", async () => {
  // Content that contains almost-boundaries and CRLFs.
  const content = Buffer.concat([randomBytes(200_000), enc(`\r\n--${boundary.slice(0, -1)}x\r\n--`), randomBytes(70_000)]);
  const body = form([
    { name: "pageId", value: "11111111-2222-3333-4444-555555555555" },
    { name: "purpose", value: "cover" },
    { name: "file", filename: "Bild ä.png", type: "image/png", data: content },
    { name: "fileId", value: "after-the-file" },
  ]);
  for (const sizes of [[7, 13, 64], [65536], [body.length]]) {
    const parsed = await readMultipartStream(chunked(body, sizes), contentType, options());
    assert.equal(parsed.fields.get("pageId"), "11111111-2222-3333-4444-555555555555");
    assert.equal(parsed.fields.get("purpose"), "cover");
    assert.equal(parsed.fields.get("fileId"), "after-the-file");
    assert.equal(parsed.file?.name, "Bild ä.png");
    assert.equal(parsed.file?.type, "image/png");
    assert.equal(parsed.file?.size, content.length);
    assert.ok(readFileSync(parsed.file!.path).equals(content), `content for chunks ${sizes}`);
    assert.ok(parsed.file!.head.equals(content.subarray(0, HEAD_BYTES)));
    parsed.discard();
    assert.equal(existsSync(parsed.file!.path), false);
  }
  const small = form([{ name: "a", value: "eins" }, { name: "file", filename: "x.txt", data: enc("hallo\r\nwelt") }]);
  const parsed = await readMultipartStream(chunked(small, [1]), contentType, options());
  assert.equal(parsed.fields.get("a"), "eins");
  assert.equal(readFileSync(parsed.file!.path, "utf8"), "hallo\r\nwelt");
  parsed.discard();
});

test("the multipart reader refuses too large files, broken bodies and a second file, leaving nothing behind", async () => {
  const before = existsSync(incomingDir(uploads)) ? readdirSync(incomingDir(uploads)).length : 0;
  const big = form([{ name: "file", filename: "a.bin", data: randomBytes(300_000) }]);
  await assert.rejects(readMultipartStream(chunked(big, [4096]), contentType, options(200_000)), (e: Error) => e instanceof HttpError && e.status === 413);
  const cut = big.subarray(0, 100_000);
  await assert.rejects(readMultipartStream(chunked(cut, [4096]), contentType, options()), (e: Error) => e instanceof HttpError && e.status === 400);
  const two = form([{ name: "file", filename: "a", data: enc("1") }, { name: "file", filename: "b", data: enc("2") }]);
  await assert.rejects(readMultipartStream(chunked(two, [10]), contentType, options()), (e: Error) => e instanceof HttpError && e.status === 400);
  await assert.rejects(readMultipartStream(chunked(big, [4096]), "application/json", options()), (e: Error) => e instanceof HttpError && e.status === 400);
  // A refusal before the file (fields sent first) stops the upload early.
  const early = form([{ name: "pageId", value: "nope" }, { name: "file", filename: "a.bin", data: randomBytes(300_000) }]);
  const earlyStream = chunked(early, [1000]);
  await assert.rejects(
    readMultipartStream(earlyStream, contentType, {
      ...options(),
      beforeFile: async (fields) => {
        if (fields.get("pageId") === "nope") throw new HttpError(403, "no");
      },
    }),
    (e: Error) => e instanceof HttpError && e.status === 403,
  );
  const after = existsSync(incomingDir(uploads)) ? readdirSync(incomingDir(uploads)).length : 0;
  assert.equal(after, before, "no temporary file is left");
});

test("leftover temporary files are swept after a day", () => {
  const old = join(incomingDir(uploads), "old.upload"),
    fresh = join(incomingDir(uploads), "fresh.upload");
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  const day = new Date(Date.now() - 25 * 3600e3);
  utimesSync(old, day, day);
  sweepIncoming(uploads);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  rmSync(fresh);
});

test("a large upload streams to disk with flat memory", async () => {
  // 384 MB generated on the fly; never held anywhere in full.
  const total = 384 * 1024 * 1024;
  const block = randomBytes(64 * 1024);
  const head = enc(`--${boundary}\r\nContent-Disposition: form-data; name="pageId"\r\n\r\np\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = enc(`\r\n--${boundary}--\r\n`);
  let sent = 0,
    stage = 0;
  const hash = createHash("sha256");
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        stage = 1;
        return controller.enqueue(new Uint8Array(head));
      }
      if (sent < total) {
        const piece = block.subarray(0, Math.min(block.length, total - sent));
        hash.update(piece);
        sent += piece.length;
        return controller.enqueue(new Uint8Array(piece));
      }
      if (stage === 1) {
        stage = 2;
        return controller.enqueue(new Uint8Array(tail));
      }
      controller.close();
    },
  });
  const used = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const base = used();
  let peak = 0;
  const sampler = setInterval(() => (peak = Math.max(peak, used() - base)), 5);
  const parsed = await readMultipartStream(body, contentType, options(total));
  clearInterval(sampler);
  peak = Math.max(peak, used() - base);
  assert.equal(parsed.file!.size, total);
  assert.equal(statSync(parsed.file!.path).size, total);
  const onDisk = createHash("sha256");
  for await (const piece of createReadStream(parsed.file!.path)) onDisk.update(piece as Buffer);
  parsed.discard();
  assert.equal(onDisk.digest("hex"), hash.digest("hex"));
  // The file is 384 MB; what the reader held at any time stays far below.
  assert.ok(peak < 96 * 1024 * 1024, `memory grew by ${Math.round(peak / 1024 / 1024)} MB`);
});

test("idempotency hashes a large body on the way, equal to the buffered hash", async () => {
  const content = randomBytes(150_000);
  const body = form([{ name: "pageId", value: "x" }, { name: "file", filename: "f", data: content }]);
  const replaced = Buffer.from(body.toString("latin1").split(`--${boundary}`).join("--flowplan-boundary"), "latin1");
  const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
  const expected = sha(`POST\n/api/upload\n${sha(replaced)}`);
  for (const sizes of [[1, 2, 3], [17], [4096], [body.length]]) {
    const req = new Request("http://localhost/api/upload?lang=en", { method: "POST", headers: { "content-type": contentType }, body: chunked(body, sizes), duplex: "half" } as RequestInit);
    const hashing = streamedHash(req);
    const reader = req.body!.pipeThrough(hashing.through).getReader();
    while (!(await reader.read()).done);
    assert.equal(hashing.complete(), true);
    assert.equal(hashing.digest(), expected, `chunks ${sizes}`);
  }
});

test("idempotency: an upload above the buffered limit is applied once, its retry replayed", async () => {
  const { id, run } = await import("../lib/db");
  const I = await import("../lib/idempotency");
  const uid = id(),
    cookie = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Big", "big@example.test");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(cookie).digest("hex"), uid, "[]", Date.now() + 3600_000);
  let applied = 0;
  const upload = I.withIdempotency(async (req: Request) => {
    const parsed = await readMultipartStream(req.body, req.headers.get("content-type"), options());
    applied++;
    const size = parsed.file!.size;
    parsed.discard();
    return Response.json({ size, applied });
  });
  const content = randomBytes(9 * 1024 * 1024);
  const request = (data: Buffer) => {
    const body = form([{ name: "file", filename: "f", data }]);
    return new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { cookie: `flowplan_session=${cookie}`, "Idempotency-Key": "large-upload-1", "content-type": contentType, "content-length": String(body.length) },
      body: chunked(body, [65536]),
      duplex: "half",
    } as RequestInit);
  };
  const first = await upload(request(content));
  assert.deepEqual(await first.json(), { size: content.length, applied: 1 });
  const retry = await upload(request(content));
  assert.equal(retry.headers.get("Idempotent-Replayed"), "true");
  assert.deepEqual(await retry.json(), { size: content.length, applied: 1 });
  const other = await upload(request(randomBytes(9 * 1024 * 1024)));
  assert.equal(other.status, 422);
  assert.equal(applied, 1);
});

// A JPEG with EXIF GPS and an XMP block, and a PNG with an eXIf chunk.
function jpegWithGps(padding = 0) {
  const tiff = Buffer.alloc(80);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(2, 28);
  tiff.writeUInt16LE(5, 30);
  tiff.writeUInt32LE(3, 32);
  tiff.writeUInt32LE(44, 36);
  for (let i = 0; i < 6; i++) tiff.writeUInt32LE([52, 1, 31, 1, 12, 1][i], 44 + i * 4);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, exif.length + 2]), exif]);
  const xmp = Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude='52'/>", "latin1");
  const app1x = Buffer.concat([Buffer.from([0xff, 0xe1, 0, xmp.length + 2]), xmp]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app1x, Buffer.from([0xff, 0xda, 0, 2]), randomBytes(padding), Buffer.from([0xff, 0xd9])]);
}
function pngWithExif() {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", Buffer.alloc(13)), chunk("eXIf", Buffer.from("MM\0*GPS-DATA")), chunk("IDAT", randomBytes(5000)), chunk("IEND", Buffer.alloc(0))]);
}

test("photos on disk lose their location exactly as in memory; others stay untouched", async () => {
  for (const [mime, data] of [["image/jpeg", jpegWithGps(3 * 1024 * 1024)], ["image/png", pngWithExif()]] as const) {
    const path = join(dir, `photo-${mime.replace("/", "-")}`);
    writeFileSync(path, data);
    assert.equal(await stripLocationFile(path, mime), true);
    assert.ok(readFileSync(path).equals(stripLocation(data, mime)), mime);
    assert.ok(!readFileSync(path).toString("latin1").includes("GPSLatitude"));
    // Nothing left to remove: the file is not rewritten.
    const at = statSync(path).mtimeMs;
    assert.equal(await stripLocationFile(path, mime), false);
    assert.equal(statSync(path).mtimeMs, at);
  }
  const other = join(dir, "other.bin");
  writeFileSync(other, "not a photo");
  assert.equal(await stripLocationFile(other, "image/jpeg"), false);
  assert.equal(readFileSync(other, "utf8"), "not a photo");
});

test("large files go into the bucket in parts and come back streamed (plain and encrypted)", async () => {
  const config = storageConfig()!;
  for (const key of [null, randomBytes(32).toString("base64")]) {
    if (key) process.env.FLOWPLAN_ENCRYPTION_KEY = key;
    else delete process.env.FLOWPLAN_ENCRYPTION_KEY;
    const name = `large${key ? "Enc" : "Plain"}`;
    const content = randomBytes(2 * PART_BYTES + 12345);
    const path = join(dir, `${name}.src`);
    writeFileSync(path, content);
    s3.largestBody.value = 0;
    const before = s3.requests.length;
    let progress = 0;
    await putObject(config, name, path, async () => void progress++);
    const object = s3.objects.get(`/bucket/flowplan/uploads/${name}`)!.body;
    assert.equal(progress, 3, "three parts");
    assert.ok(s3.requests.slice(before).some((r) => r.startsWith("POST") && r.includes("?uploads")));
    assert.ok(s3.largestBody.value <= PART_BYTES, "no request carries more than a part");
    assert.equal(s3.multipart.size, 0);
    if (key) {
      assert.equal(object.subarray(0, 4).toString("latin1"), "FPE1");
      assert.equal(object.length, content.length + 40);
    } else assert.ok(object.equals(content));
    // Back from the bucket: streamed to disk and decrypted there.
    assert.equal(await ensureLocal(name), true);
    assert.ok(readFileSync(join(uploadsDir(), name)).equals(content));
    assert.deepEqual(readdirSync(uploadsDir()).filter((n) => n.startsWith(name) && n !== name), [], "no partial file is left");
  }
  // Small files still go up in one PUT.
  const small = join(dir, "small.src");
  writeFileSync(small, randomBytes(1000));
  await putObject(config, "smallOne", small);
  assert.equal(s3.objects.get("/bucket/flowplan/uploads/smallOne")!.body.length, 1000 + 40);
  assert.ok(SINGLE_PUT_BYTES >= 5 * 1024 * 1024);
  delete process.env.FLOWPLAN_ENCRYPTION_KEY;
});

test("a failed part aborts the multipart upload", async () => {
  const config = storageConfig()!;
  const path = join(dir, "failing.src");
  writeFileSync(path, randomBytes(PART_BYTES + 10));
  s3.failing.add("partNumber=2");
  await assert.rejects(putObject(config, "failingOne", path));
  s3.failing.clear();
  assert.equal(s3.objects.has("/bucket/flowplan/uploads/failingOne"), false);
  assert.equal(s3.multipart.size, 0, "aborted");
});

test("the upload limit goes up to 10240 MB; in-memory paths keep 1 GB", () => {
  assert.equal(MAX_UPLOAD_MB, 10240);
  const shape = instanceSettingsSchema.shape.maxUploadMb;
  assert.equal(shape.safeParse(10240).success, true);
  assert.equal(shape.safeParse(10241).success, false);
  assert.equal(userLimitsSchema.shape.uploadMb.safeParse(10240).success, true);
  assert.equal(userLimitsSchema.shape.uploadMb.safeParse(10241).success, false);
  assert.equal(IN_MEMORY_FILE_MB, 1024);
  assert.equal(importLimitMb(10240, null), 1024);
  assert.equal(importLimitMb(50, null), 100);
  assert.equal(importLimitMb(10240, 5000), 5000);
});
