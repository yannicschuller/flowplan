// End-to-end encryption for encrypted spaces: the cryptography both sides
// share. It runs on WebCrypto only (browsers and Node 22+), so the browser
// encrypts and decrypts and the tests check the very same code. The server
// never calls the unwrapping or decrypting parts; it stores what these
// functions produce as opaque blobs (lib/e2ee-server.ts).
//
// Overview (docs/e2ee-design.md has the full design):
// - Every person has an X25519 key pair. The private key is wrapped twice
//   with AES-256-GCM: with a key derived from the passphrase (PBKDF2-SHA256,
//   600 000 iterations) and with a key derived from a random 256-bit
//   recovery key (HKDF-SHA256).
// - Every encrypted space has a random AES-256-GCM space key per key
//   version, wrapped for each member's public key (ephemeral-static X25519,
//   HKDF-SHA256, AES-256-GCM).
// - Document updates, snapshots, titles and files are encrypted with the
//   space key. The associated data binds each ciphertext to its page and
//   purpose, so the server cannot move it to another page or slot.

export const PBKDF2_ITERATIONS = 600_000;
// The stored title of a page whose real title is encrypted.
export const ENCRYPTED_TITLE = "Verschlüsselte Seite";
export const FORMAT = 1;
const IV_BYTES = 12;
const subtle = () => {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto is not available.");
  return value;
};
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const utf8 = (text: string) => encoder.encode(text) as Uint8Array<ArrayBuffer>;
const buffer = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

// ---- Encodings ----

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function toBase32(bytes: Uint8Array) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
export function fromBase32(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0,
    value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---- Recovery key: 32 random bytes as 52 base32 characters in groups ----

export const RECOVERY_BYTES = 32;
export function newRecoveryKey() {
  return formatRecoveryKey(randomBytes(RECOVERY_BYTES));
}
export function formatRecoveryKey(bytes: Uint8Array) {
  return toBase32(bytes).match(/.{1,4}/g)!.join("-");
}
// Spaces, dashes and case do not matter; 0/1/8 are read as O/I/B, the
// letters people tend to mistake them for.
export function parseRecoveryKey(text: string): Uint8Array<ArrayBuffer> | null {
  const clean = text.toUpperCase().replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B").replace(/[\s-]/g, "");
  if (!/^[A-Z2-7]{52}$/.test(clean)) return null;
  const bytes = fromBase32(clean);
  return bytes.length === RECOVERY_BYTES ? bytes : null;
}

// ---- Blobs stored on the server (JSON, base64 fields) ----

export type PassphraseWrap = { alg: "PBKDF2-SHA256/AES-256-GCM"; v: number; salt: string; iterations: number; iv: string; ct: string };
export type RecoveryWrap = { alg: "HKDF-SHA256/AES-256-GCM"; v: number; salt: string; iv: string; ct: string };
export type SealedKey = { alg: "X25519-HKDF-SHA256/AES-256-GCM"; v: number; epk: string; salt: string; iv: string; ct: string };
export type Identity = { publicKey: string; wrappedPrivate: PassphraseWrap; recoveryWrapped: RecoveryWrap };

// ---- AES-GCM with associated data ----

async function aesKey(raw: Uint8Array, extractable = false) {
  return subtle().importKey("raw", buffer(raw), { name: "AES-GCM" }, extractable, ["encrypt", "decrypt"]);
}
async function seal(key: CryptoKey, plain: Uint8Array, aad: string) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, buffer(plain)));
  return { iv, ct };
}
async function open(key: CryptoKey, iv: Uint8Array, ct: Uint8Array, aad: string) {
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buffer(iv), additionalData: utf8(aad) }, key, buffer(ct)));
  } catch {
    throw new DecryptError();
  }
}
export class DecryptError extends Error {
  constructor() {
    super("Decryption failed.");
    this.name = "DecryptError";
  }
}

// ---- Passphrase and recovery wraps of the private key ----

async function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await subtle().importKey("raw", utf8(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: buffer(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function recoveryKey(recovery: Uint8Array, salt: Uint8Array) {
  const base = await subtle().importKey("raw", buffer(recovery), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: utf8("flowplan e2ee recovery v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
const PRIVATE_AAD = "flowplan:e2ee:private-key:v1";

export async function wrapWithPassphrase(pkcs8: Uint8Array, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<PassphraseWrap> {
  const salt = randomBytes(16);
  const { iv, ct } = await seal(await passphraseKey(passphrase, salt, iterations), pkcs8, PRIVATE_AAD);
  return { alg: "PBKDF2-SHA256/AES-256-GCM", v: FORMAT, salt: toBase64(salt), iterations, iv: toBase64(iv), ct: toBase64(ct) };
}
export async function unwrapWithPassphrase(wrap: PassphraseWrap, passphrase: string) {
  if (wrap.iterations < 100_000) throw new DecryptError();
  return open(await passphraseKey(passphrase, fromBase64(wrap.salt), wrap.iterations), fromBase64(wrap.iv), fromBase64(wrap.ct), PRIVATE_AAD);
}
export async function wrapWithRecovery(pkcs8: Uint8Array, recovery: Uint8Array): Promise<RecoveryWrap> {
  const salt = randomBytes(16);
  const { iv, ct } = await seal(await recoveryKey(recovery, salt), pkcs8, PRIVATE_AAD);
  return { alg: "HKDF-SHA256/AES-256-GCM", v: FORMAT, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(ct) };
}
export async function unwrapWithRecovery(wrap: RecoveryWrap, recovery: Uint8Array) {
  return open(await recoveryKey(recovery, fromBase64(wrap.salt)), fromBase64(wrap.iv), fromBase64(wrap.ct), PRIVATE_AAD);
}

// ---- Key pairs ----

export function x25519Supported() {
  return (async () => {
    try {
      await subtle().generateKey({ name: "X25519" }, false, ["deriveBits"]);
      return true;
    } catch {
      return false;
    }
  })();
}
export async function generateKeyPair() {
  const pair = (await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    publicKey: toBase64(new Uint8Array(await subtle().exportKey("raw", pair.publicKey))),
    pkcs8: new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey)),
  };
}
export async function importPrivateKey(pkcs8: Uint8Array) {
  return subtle().importKey("pkcs8", buffer(pkcs8), { name: "X25519" }, false, ["deriveBits"]);
}
async function importPublicKey(publicKey: string) {
  const raw = fromBase64(publicKey);
  if (raw.length !== 32) throw new Error("Invalid public key.");
  return subtle().importKey("raw", raw, { name: "X25519" }, true, []);
}
export function validPublicKey(publicKey: string) {
  try {
    return fromBase64(publicKey).length === 32;
  } catch {
    return false;
  }
}

// A new identity: key pair, both wraps and the recovery key to write down.
export async function createIdentity(passphrase: string, iterations = PBKDF2_ITERATIONS) {
  const { publicKey, pkcs8 } = await generateKeyPair();
  const recovery = randomBytes(RECOVERY_BYTES);
  const identity: Identity = {
    publicKey,
    wrappedPrivate: await wrapWithPassphrase(pkcs8, passphrase, iterations),
    recoveryWrapped: await wrapWithRecovery(pkcs8, recovery),
  };
  return { identity, recoveryKey: formatRecoveryKey(recovery), privateKey: await importPrivateKey(pkcs8) };
}

// ---- Space keys, sealed for a member's public key ----

export function spaceKeyContext(spaceId: string, version: number, userId: string) {
  return `flowplan:e2ee:space-key:v1:${spaceId}:${version}:${userId}`;
}
async function sharedKey(privateKey: CryptoKey, publicKey: CryptoKey, salt: Uint8Array, context: string) {
  const secret = await subtle().deriveBits({ name: "X25519", public: publicKey }, privateKey, 256);
  const base = await subtle().importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: utf8(context) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function sealKey(raw: Uint8Array, recipientPublicKey: string, context: string): Promise<SealedKey> {
  const ephemeral = (await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const salt = randomBytes(16);
  const key = await sharedKey(ephemeral.privateKey, await importPublicKey(recipientPublicKey), salt, context);
  const { iv, ct } = await seal(key, raw, context);
  return {
    alg: "X25519-HKDF-SHA256/AES-256-GCM",
    v: FORMAT,
    epk: toBase64(new Uint8Array(await subtle().exportKey("raw", ephemeral.publicKey))),
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(ct),
  };
}
export async function openKey(sealed: SealedKey, privateKey: CryptoKey, context: string) {
  const key = await sharedKey(privateKey, await importPublicKey(sealed.epk), fromBase64(sealed.salt), context);
  const raw = await open(key, fromBase64(sealed.iv), fromBase64(sealed.ct), context);
  if (raw.length !== 32) throw new DecryptError();
  return raw;
}

// A space key in memory: the raw bytes (to seal it for new members) and the
// imported key for content.
export type SpaceKey = { version: number; raw: Uint8Array; key: CryptoKey };
export async function newSpaceKey(version: number): Promise<SpaceKey> {
  const raw = randomBytes(32);
  return { version, raw, key: await aesKey(raw) };
}
export async function spaceKeyFromRaw(version: number, raw: Uint8Array): Promise<SpaceKey> {
  return { version, raw, key: await aesKey(raw) };
}

// ---- Content: [format][iv][ciphertext+tag] ----

export type Purpose = "update" | "snapshot" | "title";
export function contentContext(purpose: Purpose, pageId: string, version: number) {
  return `flowplan:e2ee:${purpose}:v1:${pageId}:${version}`;
}
export async function encryptContent(key: SpaceKey, plain: Uint8Array, context: string) {
  const { iv, ct } = await seal(key.key, plain, context);
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = FORMAT;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}
export async function decryptContent(key: SpaceKey, data: Uint8Array, context: string) {
  if (data[0] !== FORMAT || data.length < 1 + IV_BYTES + 16) throw new DecryptError();
  return open(key.key, data.subarray(1, 1 + IV_BYTES), data.subarray(1 + IV_BYTES), context);
}

// Titles: {v: key version, d: base64}, as JSON text in pages.title_cipher.
export async function encryptTitle(key: SpaceKey, pageId: string, title: string) {
  const data = await encryptContent(key, utf8(title), contentContext("title", pageId, key.version));
  return JSON.stringify({ v: key.version, d: toBase64(data) });
}
export function titleVersion(cipher: string) {
  try {
    const parsed = JSON.parse(cipher) as { v?: unknown };
    return typeof parsed.v === "number" ? parsed.v : null;
  } catch {
    return null;
  }
}
export async function decryptTitle(keys: (version: number) => SpaceKey | undefined, pageId: string, cipher: string) {
  const parsed = JSON.parse(cipher) as { v: number; d: string };
  const key = keys(parsed.v);
  if (!key) throw new DecryptError();
  return decoder.decode(await decryptContent(key, fromBase64(parsed.d), contentContext("title", pageId, parsed.v)));
}

// ---- Files: "FPX1" | header length (4 bytes) | header JSON | content ----
// The header names the space key version, a random file nonce and the file
// key sealed with the space key; the content holds name, type and bytes.
const FILE_MAGIC = utf8("FPX1");
type FileHeader = { v: number; n: string; k: string };
const fileKeyContext = (pageId: string, nonce: string, version: number) => `flowplan:e2ee:file-key:v1:${pageId}:${nonce}:${version}`;
const fileContext = (pageId: string, nonce: string) => `flowplan:e2ee:file:v1:${pageId}:${nonce}`;

export async function encryptFile(key: SpaceKey, pageId: string, file: { name: string; mime: string; bytes: Uint8Array }) {
  const nonce = toBase64(randomBytes(12));
  const fileKey = await newSpaceKey(0);
  const wrapped = await encryptContent(key, fileKey.raw, fileKeyContext(pageId, nonce, key.version));
  const header = utf8(JSON.stringify({ v: key.version, n: nonce, k: toBase64(wrapped) } satisfies FileHeader));
  const meta = utf8(JSON.stringify({ name: file.name, mime: file.mime }));
  const plain = new Uint8Array(4 + meta.length + file.bytes.length);
  new DataView(plain.buffer).setUint32(0, meta.length);
  plain.set(meta, 4);
  plain.set(file.bytes, 4 + meta.length);
  const body = await encryptContent(fileKey, plain, fileContext(pageId, nonce));
  const out = new Uint8Array(FILE_MAGIC.length + 4 + header.length + body.length);
  out.set(FILE_MAGIC, 0);
  new DataView(out.buffer).setUint32(FILE_MAGIC.length, header.length);
  out.set(header, FILE_MAGIC.length + 4);
  out.set(body, FILE_MAGIC.length + 4 + header.length);
  return out;
}
export function isEncryptedFile(bytes: Uint8Array) {
  return bytes.length > 8 && FILE_MAGIC.every((b, i) => bytes[i] === b);
}
export async function decryptFile(keys: (version: number) => SpaceKey | undefined, pageId: string, bytes: Uint8Array) {
  if (!isEncryptedFile(bytes)) throw new DecryptError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(FILE_MAGIC.length);
  const start = FILE_MAGIC.length + 4;
  const header = JSON.parse(decoder.decode(bytes.subarray(start, start + headerLength))) as FileHeader;
  const key = keys(header.v);
  if (!key) throw new DecryptError();
  const raw = await decryptContent(key, fromBase64(header.k), fileKeyContext(pageId, header.n, header.v));
  const plain = await decryptContent(await spaceKeyFromRaw(0, raw), bytes.subarray(start + headerLength), fileContext(pageId, header.n));
  const metaLength = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
  const meta = JSON.parse(decoder.decode(plain.subarray(4, 4 + metaLength))) as { name: string; mime: string };
  return { name: meta.name, mime: meta.mime, bytes: plain.slice(4 + metaLength) };
}
