// Time-based one-time passwords (RFC 6238) as authenticator apps show them:
// HMAC-SHA1, six digits, 30-second steps. Pure functions; storing secrets,
// limits and recovery codes live in lib/two-factor.ts.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(data: Uint8Array) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text: string) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Ungültiges Base32.");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
// 160 random bits, as RFC 4226 recommends.
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: Uint8Array, counter: number) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}
export const timeStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);
export const totpCode = (secret: string, now = Date.now()) => hotp(base32Decode(secret), timeStep(now));

// The time step a code belongs to: the current one or one step either side
// (clocks drift, people type slowly). Steps up to `lastStep` were used
// already and do not count again. Every candidate is compared, in constant
// time, so the answer takes as long whichever step matches.
export function matchTotp(secret: string, code: string, now = Date.now(), lastStep = 0): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secret);
  const step = timeStep(now);
  let found: number | null = null;
  for (const candidate of [step - 1, step, step + 1]) {
    const equal = timingSafeEqual(Buffer.from(hotp(key, candidate)), Buffer.from(digits));
    if (equal && candidate > lastStep && found === null) found = candidate;
  }
  return found;
}

// What the QR code holds: otpauth://totp/Issuer:account?secret=…&issuer=…
export function otpauthUri(secret: string, account: string, issuer: string) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}
