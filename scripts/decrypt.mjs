#!/usr/bin/env node
// Emergency decryption without a running Flowplan: turns a file Flowplan
// encrypted (a scheduled backup flowplan-….sqlite.enc, a Markdown export
// ….zip.enc, the instance backup ….zip.enc or an object from uploads/ in
// the bucket) back into the original. Needs only Node.js, no packages.
//
//   FLOWPLAN_ENCRYPTION_KEY=… node decrypt.mjs <file.enc> [output]
//   node decrypt.mjs --key-file /run/secrets/flowplan-key <file.enc> [output]
//   node decrypt.mjs --new-key        prints a new random key
//
// Several keys (after a rotation) are tried by their id, from
// FLOWPLAN_ENCRYPTION_KEY, FLOWPLAN_ENCRYPTION_KEY_FILE and
// FLOWPLAN_ENCRYPTION_KEY_PREVIOUS. In the Docker image:
//   docker exec flowplan node decrypt.mjs data/backups/flowplan-….sqlite.enc
// Format (lib/encryption.ts): "FPE1" | key id (8) | IV (12) | data | tag (16).
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const args = process.argv.slice(2);
if (args[0] === "--new-key") {
  console.log(randomBytes(32).toString("base64"));
  process.exit(0);
}
const texts = [];
const keyFile = args[0] === "--key-file" ? (args.shift(), args.shift()) : process.env.FLOWPLAN_ENCRYPTION_KEY_FILE;
if (process.env.FLOWPLAN_ENCRYPTION_KEY) texts.push(process.env.FLOWPLAN_ENCRYPTION_KEY);
if (keyFile) texts.push(readFileSync(keyFile, "utf8"));
texts.push(...(process.env.FLOWPLAN_ENCRYPTION_KEY_PREVIOUS || "").split(","));
const keys = texts
  .map((t) => t.trim())
  .filter(Boolean)
  .map((t) => {
    const secret = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
    if (secret.length !== 32) fail("Ein Schlüssel ist nicht 32 Bytes lang (base64). / A key is not 32 bytes long (base64).");
    return { secret, id: createHash("sha256").update("flowplan-encryption-key-id\0").update(secret).digest().subarray(0, 8) };
  });
const [source, given] = args;
if (!source) fail("Aufruf / usage: FLOWPLAN_ENCRYPTION_KEY=… node decrypt.mjs <file.enc> [output]");
if (!keys.length) fail("Kein Schlüssel: FLOWPLAN_ENCRYPTION_KEY oder --key-file. / No key: FLOWPLAN_ENCRYPTION_KEY or --key-file.");
const target = given || (source.endsWith(".enc") ? source.slice(0, -4) : `${source}.decrypted`);

const size = statSync(source).size;
const head = Buffer.alloc(24),
  tag = Buffer.alloc(16);
const fd = openSync(source, "r");
readSync(fd, head, 0, 24, 0);
if (size >= 40) readSync(fd, tag, 0, 16, size - 16);
closeSync(fd);
if (size < 40 || head.subarray(0, 4).toString() !== "FPE1") fail("Keine verschlüsselte Flowplan-Datei. / Not a file encrypted by Flowplan.");
const id = head.subarray(4, 12);
const key = keys.find((k) => k.id.equals(id));
if (!key) fail(`Die Datei ist mit dem Schlüssel ${id.toString("hex")} verschlüsselt; vorhanden: ${keys.map((k) => k.id.toString("hex")).join(", ")}. / Encrypted with key ${id.toString("hex")}, which was not given.`);
const decipher = createDecipheriv("aes-256-gcm", key.secret, head.subarray(12, 24));
decipher.setAAD(head.subarray(0, 12));
decipher.setAuthTag(tag);
// Written next to the target and renamed only when the tag checks out.
const partial = `${target}.part`;
try {
  const body = size > 40 ? createReadStream(source, { start: 24, end: size - 17 }) : Readable.from([]);
  await pipeline(body, decipher, createWriteStream(partial, { flags: "wx" }));
  renameSync(partial, target);
  console.log(target);
} catch (error) {
  rmSync(partial, { force: true });
  fail(error?.code === "EEXIST" ? `${partial} existiert schon. / already exists.` : "Entschlüsseln fehlgeschlagen: falscher Schlüssel oder beschädigte Datei. / Decryption failed: wrong key or damaged file.");
}
