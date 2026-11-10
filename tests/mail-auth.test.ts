// Which Authentication-Results header the sender check trusts (lib/mail-auth.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mailVerdict, parseAuthResults, verdictFromResults } from "../lib/mail-auth";

const from = "ceo@victim.example";
const AR = "Authentication-Results";

test("without INBOUND_MAIL_AUTHSERV_ID a pass never counts: the only header may be the sender's own", () => {
  // The receiving server added nothing; the attacker wrote this header.
  assert.equal(mailVerdict([[AR, "mx.victim.example; dmarc=pass header.from=victim.example"]], from, ""), "unknown");
  assert.equal(mailVerdict([[AR, "mx.local; dkim=pass header.d=victim.example; spf=pass smtp.mailfrom=victim.example"]], from, ""), "unknown");
  // A failure from the topmost header still counts – it only makes the check stricter.
  assert.equal(mailVerdict([[AR, "mx.local; dmarc=fail header.from=victim.example"]], from, ""), "fail");
  assert.equal(
    mailVerdict(
      [
        [AR, "mx.local; spf=pass smtp.mailfrom=victim.example"],
        [AR, "evil; dmarc=fail header.from=victim.example"],
      ],
      from,
      "",
    ),
    "unknown",
    "only the topmost header, and its pass does not count",
  );
});

test("with INBOUND_MAIL_AUTHSERV_ID only the topmost header of that server counts", () => {
  const genuine: [string, string] = [AR, "mx.local; dkim=fail header.d=victim.example; spf=none smtp.mailfrom=victim.example"];
  const forged: [string, string] = [AR, "mx.local; dkim=pass header.d=victim.example"];
  assert.equal(mailVerdict([genuine, forged], from, "mx.local"), "fail");
  const neutral: [string, string] = [AR, "mx.local; spf=none smtp.mailfrom=victim.example"];
  assert.equal(mailVerdict([neutral, forged], from, "mx.local"), "unknown", "a forged same-id header below cannot add a pass");
  // Headers of other servers above it are skipped.
  assert.equal(mailVerdict([[AR, "relay.other; dmarc=fail header.from=victim.example"], forged], from, "mx.local"), "pass");
  assert.equal(mailVerdict([[AR, "mx.local; dmarc=pass header.from=victim.example"]], from, "mx.local"), "pass");
});

test("dmarc=pass only counts when header.from is the From domain", () => {
  const ar = (v: string) => verdictFromResults(parseAuthResults(v).results, from);
  assert.equal(ar("mx.local; dmarc=pass header.from=attacker.example"), "unknown");
  assert.equal(ar("mx.local; dmarc=pass"), "unknown");
  assert.equal(ar("mx.local; dmarc=pass header.from=victim.example"), "pass");
  assert.equal(ar("mx.local; dmarc=pass header.from=VICTIM.example"), "pass");
  // A misaligned dmarc pass does not hide an aligned DKIM pass.
  assert.equal(ar("mx.local; dmarc=pass header.from=attacker.example; dkim=pass header.d=victim.example"), "pass");
  // A dmarc failure of another domain is not ours either, but an unknown header.from fail stays a fail.
  assert.equal(ar("mx.local; dmarc=fail"), "fail");
});
