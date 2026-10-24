// The instance's identity towards the push relay (PROTOCOL.md §1 and §3 of
// flowplan-push): an Ed25519 key pair, created on first use. The public key
// is published at /.well-known/flowplan-push; the private key is stored only
// sealed (lib/ai/secrets.ts, bound to its key id) and never leaves this file.
//
// Rotation (rotatePushIdentity): the new key is listed at once but signs
// only after PUBLISH_DELAY, so a relay (or a cache in between) that still
// holds the document of the last hour knows it by then; the old key stays
// listed for the grace period (default 7 days) and is then deleted. In an
// emergency (`immediate`) the new key signs at once and the old one is
// removed at once.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { all, one, run, transaction } from "./db";
import { openSecret, sealSecret } from "./secret-box";

export const PUSH_SIGNATURE_CONTEXT = "flowplan-push-v1";
// A little more than the hour a relay may cache the key document.
export const PUBLISH_DELAY = 65 * 60_000;
export const DEFAULT_GRACE = 7 * 24 * 3_600_000;

type KeyRow = { kid: string; public_key: string; private_key: string; created_at: number; active_from: number; retire_at: number | null };

const aad = (kid: string) => `push-identity:${kid}`;
// The raw 32-byte public key from a KeyObject.
const rawPublic = (key: KeyObject) => Buffer.from(key.export({ format: "jwk" }).x as string, "base64url");
// Key id: the first 96 bits of the public key's SHA-256, base64url.
export const keyId = (publicKey: Buffer) => createHash("sha256").update(publicKey).digest().subarray(0, 12).toString("base64url");

function insertKey(now: number, activeFrom: number) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = rawPublic(publicKey);
  const kid = keyId(pub);
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  run(
    "INSERT INTO push_identity_keys(kid,public_key,private_key,created_at,active_from,retire_at) VALUES(?,?,?,?,?,NULL)",
    kid,
    pub.toString("base64url"),
    sealSecret(pkcs8, aad(kid)),
    now,
    activeFrom,
  );
  return kid;
}

function purge(now: number) {
  run("DELETE FROM push_identity_keys WHERE retire_at IS NOT NULL AND retire_at<=?", now);
}

// The key that signs now (newest active one), created on first use.
function signingRow(now: number): KeyRow {
  const pick = () =>
    one<KeyRow>("SELECT * FROM push_identity_keys WHERE active_from<=? AND (retire_at IS NULL OR retire_at>?) ORDER BY active_from DESC,created_at DESC LIMIT 1", now, now);
  const found = pick();
  if (found) return found;
  return transaction(() => {
    purge(now);
    const again = pick();
    if (again) return again;
    insertKey(now, now);
    return pick()!;
  });
}

function privateKeyOf(row: KeyRow): KeyObject {
  return createPrivateKey({ key: Buffer.from(openSecret(row.private_key, aad(row.kid)), "base64"), format: "der", type: "pkcs8" });
}

// The document of /.well-known/flowplan-push: the public keys only.
export function pushIdentityDocument(now = Date.now()) {
  signingRow(now);
  purge(now);
  const keys = all<Pick<KeyRow, "kid" | "public_key">>(
    "SELECT kid,public_key FROM push_identity_keys WHERE retire_at IS NULL OR retire_at>? ORDER BY created_at",
    now,
  );
  return { version: 1 as const, keys: keys.map((k) => ({ id: k.kid, alg: "Ed25519" as const, publicKey: k.public_key })) };
}

// The text that is signed (§3): context, instance origin, time, body hash.
export function signatureBase(instance: string, ts: number, body: Uint8Array) {
  return Buffer.from(`${PUSH_SIGNATURE_CONTEXT}\n${instance}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`, "utf8");
}

// The Flowplan-Signature header for exactly these body bytes.
export function signRelayRequest(instance: string, body: Uint8Array, now = Date.now()) {
  let row = signingRow(now);
  let key: KeyObject;
  try {
    key = privateKeyOf(row);
  } catch {
    // The secrets key changed and the stored key cannot be opened any more:
    // it is useless, so it goes and a new one takes over (the relay re-fetches
    // the document on an unknown key id).
    console.warn("push relay: the instance signing key could not be decrypted; a new one was created");
    transaction(() => {
      run("DELETE FROM push_identity_keys WHERE kid=?", row.kid);
      insertKey(now, now);
    });
    row = signingRow(now);
    key = privateKeyOf(row);
  }
  const ts = Math.floor(now / 1000);
  const sig = sign(null, signatureBase(instance, ts, body), key).toString("base64url");
  return { header: `kid=${row.kid}, ts=${ts}, sig=${sig}`, kid: row.kid, ts };
}

// A new signing key; see the top of the file. Returns the key ids.
export function rotatePushIdentity(options: { immediate?: boolean; graceMs?: number } = {}, now = Date.now()) {
  const grace = Math.max(0, Math.min(options.graceMs ?? DEFAULT_GRACE, 90 * 24 * 3_600_000));
  return transaction(() => {
    purge(now);
    // The key that signs now (it may already be retiring after an earlier rotation).
    const previous = one<KeyRow>(
      "SELECT * FROM push_identity_keys WHERE active_from<=? AND (retire_at IS NULL OR retire_at>?) ORDER BY active_from DESC,created_at DESC LIMIT 1",
      now,
      now,
    );
    if (options.immediate || !previous) {
      // Every older key goes now (a key that may have leaked).
      run("DELETE FROM push_identity_keys");
      const kid = insertKey(now, now);
      return { kid, activeFrom: now, retired: previous?.kid ?? null, retiredAt: previous ? now : null };
    }
    // Keys still waiting from an earlier rotation are replaced.
    run("DELETE FROM push_identity_keys WHERE active_from>?", now);
    const activeFrom = now + PUBLISH_DELAY;
    const kid = insertKey(now, activeFrom);
    const retiredAt = activeFrom + grace;
    // Older keys end with the grace period at the latest.
    run("UPDATE push_identity_keys SET retire_at=? WHERE kid!=? AND (retire_at IS NULL OR retire_at>?)", retiredAt, kid, retiredAt);
    // The document stays small (a relay accepts at most 10 keys): the new
    // key, the one signing now and at most three before them.
    run(
      "DELETE FROM push_identity_keys WHERE kid NOT IN (?,?) AND kid NOT IN (SELECT kid FROM push_identity_keys WHERE kid NOT IN (?,?) ORDER BY created_at DESC LIMIT 3)",
      kid,
      previous.kid,
      kid,
      previous.kid,
    );
    return { kid, activeFrom, retired: previous.kid, retiredAt };
  });
}

// For the administration: which keys exist and when they sign or end.
export function pushIdentityStatus(now = Date.now()) {
  signingRow(now);
  purge(now);
  const signing = signingRow(now).kid;
  return all<Pick<KeyRow, "kid" | "created_at" | "active_from" | "retire_at">>(
    "SELECT kid,created_at,active_from,retire_at FROM push_identity_keys ORDER BY created_at",
  ).map((k) => ({ id: k.kid, createdAt: k.created_at, activeFrom: k.active_from, retireAt: k.retire_at, signing: k.kid === signing }));
}

// Public keys as KeyObjects (tests, verification of own signatures).
export function publicKeyObject(base64url: string) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: base64url }, format: "jwk" });
}
