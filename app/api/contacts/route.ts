import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { browseUnits, contactsSourceStatus, importContacts, listPeople, syncContactsNow, unsubscribeUnit } from "@/lib/contacts-ldap";
import { contactCard, exportVCards, importVCards } from "@/lib/contacts-io";
import { createCardDavAccess, createCardDavProfileLink, hasCardDavAccess, redeemCardDavProfileLink, revokeCardDavAccess } from "@/lib/carddav";
import { requireContactsDatabase } from "@/lib/contacts";
import { requirePage } from "@/lib/permissions";
import { exportName } from "@/lib/export-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Contacts databases of the browser app (issue #64, lib/contacts*.ts):
// GET  ?page=…&view=status                 LDAP source, CardDAV access
// GET  ?page=…&view=units&parent=DN        organizational units below a DN
// GET  ?page=…&view=people&unit=DN&q=…     people of a unit (search: below it)
// GET  ?page=…&row=…&view=card             the card of a mentioned contact
// GET  ?profile=…                          iOS configuration profile (once)
// POST { action, pageId, … }               ldap.import, ldap.sync,
//      ldap.unsubscribe, vcard.import, vcard.export, carddav.create,
//      carddav.revoke, carddav.profile
const headers = { "Cache-Control": "no-store" };
const uuid = z.uuid();

function failure(e: unknown) {
  const status = e instanceof HttpError ? e.status : e instanceof ZodError || e instanceof SyntaxError ? 400 : 500;
  if (status === 500) console.error(e);
  return NextResponse.json(
    { error: status === 500 ? "Aktion fehlgeschlagen." : e instanceof ZodError || e instanceof SyntaxError ? "Ungültige Anfrage." : (e as Error).message },
    { status, headers },
  );
}
async function sessionUser() {
  const user = await requireUser();
  // Directory and address book accesses belong to the browser app.
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  return user;
}

export const GET = withRequestLocale(handleGET);
async function handleGET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const profile = params.get("profile");
    if (profile !== null) {
      const body = redeemCardDavProfileLink(profile);
      if (!body)
        return new NextResponse("Dieser Link ist abgelaufen oder wurde schon benutzt. / This link has expired or was already used.", {
          status: 410,
          headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
        });
      return new NextResponse(body, {
        headers: { ...headers, "Content-Type": "application/x-apple-aspen-config; charset=utf-8", "Content-Disposition": 'attachment; filename="flowplan-contacts.mobileconfig"' },
      });
    }
    const user = await sessionUser();
    const pageId = uuid.parse(params.get("page"));
    switch (params.get("view")) {
      case "status": {
        const page = requirePage(user, pageId);
        requireContactsDatabase(page.id);
        return NextResponse.json({ ...contactsSourceStatus(page.id), carddav: hasCardDavAccess(user, page.id) }, { headers });
      }
      case "units":
        return NextResponse.json(await browseUnits(user, pageId, params.get("parent") || undefined), { headers });
      case "people":
        return NextResponse.json(await listPeople(user, pageId, params.get("unit") || undefined, params.get("q") || ""), { headers });
      case "card":
        return NextResponse.json({ card: contactCard(user, pageId, uuid.parse(params.get("row"))) }, { headers });
      default:
        throw new HttpError(400, "Unbekannte Aktion.");
    }
  } catch (e) {
    return failure(e);
  }
}

export const POST = withRequestLocale(handlePOST);
async function handlePOST(req: Request) {
  try {
    checkOrigin(req);
    const user = await sessionUser();
    const text = await req.text();
    if (text.length > 6 * 1024 * 1024) throw new HttpError(413, "Die Datei ist zu groß (höchstens 5 MB).");
    const b = JSON.parse(text || "{}") as Record<string, unknown>;
    const pageId = uuid.parse(b.pageId);
    switch (b.action) {
      case "ldap.import":
        return NextResponse.json({ result: await importContacts(user, pageId, b), status: contactsSourceStatus(pageId) }, { headers });
      case "ldap.sync":
        return NextResponse.json({ result: await syncContactsNow(user, pageId), status: contactsSourceStatus(pageId) }, { headers });
      case "ldap.unsubscribe":
        return NextResponse.json({ status: unsubscribeUnit(user, pageId, z.string().max(1000).parse(b.unit)) }, { headers });
      case "vcard.import":
        return NextResponse.json(importVCards(user, pageId, z.string().parse(b.text)), { headers });
      case "vcard.export": {
        const rowIds = b.rowIds === undefined ? undefined : z.array(uuid).max(5000).parse(b.rowIds);
        const version = b.version === "4.0" ? "4.0" : "3.0";
        const file = exportVCards(user, pageId, rowIds, version);
        const name = `${exportName(file.title || "Kontakte")}.vcf`;
        return new NextResponse(file.text, {
          headers: {
            ...headers,
            "Content-Type": "text/vcard; charset=utf-8",
            "Content-Disposition": `attachment; filename="contacts.vcf"; filename*=UTF-8''${encodeURIComponent(name)}`,
            "X-Contacts": String(file.count),
          },
        });
      }
      case "carddav.create":
        return NextResponse.json(createCardDavAccess(user, pageId), { headers });
      case "carddav.revoke":
        revokeCardDavAccess(user, pageId);
        return NextResponse.json({ ok: true }, { headers });
      case "carddav.profile":
        return NextResponse.json(createCardDavProfileLink(user, pageId), { headers });
      default:
        throw new HttpError(400, "Unbekannte Aktion.");
    }
  } catch (e) {
    return failure(e);
  }
}
