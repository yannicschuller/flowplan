// Administration → Users → User provisioning (SCIM/LDAP): the SCIM base
// address, its tokens and last requests, and the LDAP status with a
// connection test and a sync on demand. Administrators only.
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { requireAdmin } from "@/lib/permissions";
import { createScimToken, revokeScimToken, scimOverview, ScimError } from "@/lib/scim";
import { ldapStatus, syncLdapAccounts, testLdapConnection } from "@/lib/ldap-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const failure = (e: unknown) => {
  if (!(e instanceof HttpError) && !(e instanceof ScimError)) console.error(e);
  const status = e instanceof HttpError || e instanceof ScimError ? e.status : 500;
  return Response.json({ error: e instanceof HttpError ? e.message : e instanceof ScimError ? e.message : "Aktion fehlgeschlagen." }, { status });
};
async function admin() {
  const user = await requireUser();
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  requireAdmin(user);
  return user;
}
const overview = () => ({ scim: scimOverview(), ldap: ldapStatus() });

export async function GET() {
  try {
    await admin();
    return Response.json(overview(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request) {
  try {
    checkOrigin(req);
    const user = await admin();
    const body = (await req.json().catch(() => ({}))) as { action?: unknown; name?: unknown; id?: unknown };
    switch (body.action) {
      case "scim.token.create":
        return Response.json({ ...createScimToken(user.id, body.name), ...overview() }, { headers: { "Cache-Control": "no-store" } });
      case "scim.token.revoke":
        revokeScimToken(user.id, body.id);
        return Response.json(overview());
      case "ldap.test":
        return Response.json({ test: await testLdapConnection(), ...overview() });
      case "ldap.sync":
        return Response.json({ sync: await syncLdapAccounts(), ...overview() });
      default:
        throw new HttpError(400, "Unbekannte Aktion.");
    }
  } catch (e) {
    return failure(e);
  }
}
