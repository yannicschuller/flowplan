// vCard 3.0 / 4.0 (RFC 2426, RFC 6350): reading and writing address cards
// for the contacts databases (lib/contacts.ts) – import and export of .vcf
// files and the CardDAV address book (lib/carddav.ts).
//
// Reading is forgiving: several cards per file, folded lines (also with a
// tab), property groups ("item1.EMAIL"), TYPE parameters in either spelling,
// quoted-printable from vCard 2.1, inline photos (base64 or data: URI).
// Writing always produces CRLF lines folded at 75 octets without splitting
// a UTF-8 character, with the escapes of RFC 6350 section 3.4.
//
// Client-safe: no Node APIs (photos are base64 text).

export type VCardAddress = {
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  type: string;
};
export type VCardContact = {
  uid: string;
  // Formatted name (FN).
  fn: string;
  firstName: string;
  lastName: string;
  org: string;
  title: string;
  emails: { value: string; type: string }[];
  phones: { value: string; type: string }[];
  addresses: VCardAddress[];
  // YYYY-MM-DD, or --MM-DD without a year.
  birthday: string;
  note: string;
  categories: string[];
  url: string;
  // Inline photo (base64, JPEG or PNG) – references to other servers are
  // never fetched.
  photo: { mime: string; base64: string } | null;
};

export const MAX_VCARD_BYTES = 5 * 1024 * 1024;
export const MAX_VCARDS = 2000;

export function emptyContact(): VCardContact {
  return {
    uid: "",
    fn: "",
    firstName: "",
    lastName: "",
    org: "",
    title: "",
    emails: [],
    phones: [],
    addresses: [],
    birthday: "",
    note: "",
    categories: [],
    url: "",
    photo: null,
  };
}

/* ---------- Reading ---------- */

type Property = { group: string; name: string; params: Record<string, string[]>; value: string };

// Splits on a separator that is not escaped with a backslash.
function splitEscaped(value: string, separator: string) {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      current += c + value[i + 1];
      i++;
    } else if (c === separator) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts;
}
export function unescapeText(value: string) {
  return value.replace(/\\([\\;,nN:])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}
// Parameters: TYPE=work,voice;TYPE=pref;PREF=1 and the bare v2.1 form ";WORK".
function parseParams(raw: string[]) {
  const params: Record<string, string[]> = {};
  for (const part of raw) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const name = (eq < 0 ? "TYPE" : part.slice(0, eq)).toUpperCase();
    const value = eq < 0 ? part : part.slice(eq + 1);
    const values = splitQuoted(value).map((v) => v.replace(/^"|"$/g, ""));
    (params[name] ||= []).push(...values.filter(Boolean));
  }
  return params;
}
function splitQuoted(value: string) {
  const out: string[] = [];
  let current = "",
    quoted = false;
  for (const c of value) {
    if (c === '"') quoted = !quoted;
    if (c === "," && !quoted) {
      out.push(current);
      current = "";
    } else current += c;
  }
  out.push(current);
  return out;
}
function decodeQuotedPrintable(value: string) {
  const bytes: number[] = [];
  const text = value.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(text[i]));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
// The lines of a vCard text with folding undone.
function unfold(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    // vCard 2.1 quoted-printable soft breaks continue on the next line.
    else if (out.length && /ENCODING=QUOTED-PRINTABLE/i.test(out[out.length - 1].split(":")[0]) && out[out.length - 1].endsWith("="))
      out[out.length - 1] = out[out.length - 1].slice(0, -1) + line;
    else out.push(line);
  }
  return out;
}
function parseLine(line: string): Property | null {
  // The name and parameters end at the first colon outside quotes.
  let quoted = false,
    colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = splitEscaped(line.slice(0, colon), ";");
  const [fullName, ...rawParams] = head;
  const dot = fullName.lastIndexOf(".");
  const group = dot >= 0 ? fullName.slice(0, dot) : "";
  const name = (dot >= 0 ? fullName.slice(dot + 1) : fullName).trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params = parseParams(rawParams);
  let value = line.slice(colon + 1);
  if (params.ENCODING?.some((e) => e.toUpperCase() === "QUOTED-PRINTABLE")) value = decodeQuotedPrintable(value);
  return { group, name, params, value };
}
const typeOf = (p: Property) =>
  (p.params.TYPE || [])
    .map((t) => t.toLowerCase())
    .filter((t) => !["internet", "pref", "x400", "voice"].includes(t))
    .join(",");
const isoDate = (value: string) => {
  const v = value.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^--(\d{2})-?(\d{2})$/.exec(v);
  if (m) return `--${m[1]}-${m[2]}`;
  return "";
};
function photoOf(p: Property): VCardContact["photo"] {
  const value = p.value.trim();
  const data = /^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (data) return { mime: data[1].toLowerCase().replace("jpg", "jpeg"), base64: data[2].replace(/\s+/g, "") };
  const encoding = (p.params.ENCODING || [])[0]?.toUpperCase();
  if (encoding === "B" || encoding === "BASE64") {
    const type = (p.params.TYPE || [])[0]?.toLowerCase() || "jpeg";
    const mime = type.includes("png") ? "image/png" : type.includes("jp") ? "image/jpeg" : "";
    if (!mime) return null;
    return { mime, base64: value.replace(/\s+/g, "") };
  }
  return null;
}

// Every card in a .vcf text. Cards without any name, address or number are
// left out.
export function parseVCards(text: string): VCardContact[] {
  if (text.length > MAX_VCARD_BYTES) throw new Error("vCard file too large");
  const contacts: VCardContact[] = [];
  let props: Property[] | null = null;
  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.trim().toUpperCase() === "VCARD") {
      props = [];
      continue;
    }
    if (prop.name === "END" && prop.value.trim().toUpperCase() === "VCARD") {
      if (props) {
        const contact = fromProperties(props);
        if (contact) contacts.push(contact);
        if (contacts.length > MAX_VCARDS) throw new Error("Too many vCards");
      }
      props = null;
      continue;
    }
    props?.push(prop);
  }
  return contacts;
}
function fromProperties(props: Property[]): VCardContact | null {
  const c = emptyContact();
  // Apple puts the label of a group (item1.X-ABLABEL) next to the value.
  const labels = new Map(props.filter((p) => p.name === "X-ABLABEL" && p.group).map((p) => [p.group, unescapeText(p.value).replace(/^_\$!<|>!\$_$/g, "").toLowerCase()]));
  for (const p of props) {
    const text = () => unescapeText(p.value).trim();
    const type = [typeOf(p), labels.get(p.group) || ""].filter(Boolean).join(",");
    switch (p.name) {
      case "UID":
        c.uid = text().replace(/^urn:uuid:/i, "").slice(0, 200);
        break;
      case "FN":
        c.fn = text().slice(0, 500);
        break;
      case "N": {
        const [last = "", first = ""] = splitEscaped(p.value, ";").map((v) => unescapeText(splitEscaped(v, ",").join(" ")).trim());
        c.lastName = last.slice(0, 200);
        c.firstName = first.slice(0, 200);
        break;
      }
      case "ORG":
        c.org = splitEscaped(p.value, ";").map(unescapeText).map((s) => s.trim()).filter(Boolean)[0]?.slice(0, 300) || "";
        break;
      case "TITLE":
        c.title = text().slice(0, 300);
        break;
      case "EMAIL":
        if (text() && c.emails.length < 20) c.emails.push({ value: text().replace(/^mailto:/i, "").slice(0, 300), type });
        break;
      case "TEL":
        if (text() && c.phones.length < 20) c.phones.push({ value: text().replace(/^tel:/i, "").slice(0, 100), type });
        break;
      case "ADR": {
        const [, , street = "", city = "", region = "", postalCode = "", country = ""] = splitEscaped(p.value, ";").map((v) => unescapeText(v).trim());
        if ((street || city || postalCode || country) && c.addresses.length < 10)
          c.addresses.push({ street: street.slice(0, 500), city: city.slice(0, 200), region: region.slice(0, 200), postalCode: postalCode.slice(0, 40), country: country.slice(0, 200), type });
        break;
      }
      case "BDAY":
        c.birthday = isoDate(text());
        break;
      case "NOTE":
        c.note = text().slice(0, 50_000);
        break;
      case "CATEGORIES":
        c.categories = splitEscaped(p.value, ",").map(unescapeText).map((s) => s.trim()).filter(Boolean).slice(0, 30);
        break;
      case "URL":
        if (!c.url) c.url = text().slice(0, 2000);
        break;
      case "PHOTO":
        if (!c.photo) c.photo = photoOf(p);
        break;
    }
  }
  if (!c.fn && !c.firstName && !c.lastName && !c.org && !c.emails.length && !c.phones.length) return null;
  if (!c.firstName && !c.lastName && c.fn) {
    const words = c.fn.split(/\s+/);
    c.lastName = words.length > 1 ? words.pop()! : "";
    c.firstName = words.length && c.lastName ? words.join(" ") : "";
    if (!c.lastName) c.lastName = c.fn;
  }
  return c;
}

/* ---------- Writing ---------- */

export function escapeText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}
// Folds a content line at 75 octets without splitting a UTF-8 character.
export function foldLine(line: string) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "",
    size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets, continuation lines 74 after the space.
    if (size + bytes > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
const typeParam = (type: string, version: "3.0" | "4.0") => {
  const types = type
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9-]+$/.test(t));
  if (!types.length) return "";
  return version === "4.0" ? `;TYPE=${types.length > 1 ? `"${types.join(",")}"` : types[0]}` : `;TYPE=${types.join(",")}`;
};

export function serializeVCard(contact: VCardContact, version: "3.0" | "4.0" = "3.0") {
  const fn = contact.fn || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.org || contact.emails[0]?.value || "";
  const lines = ["BEGIN:VCARD", `VERSION:${version}`];
  if (version === "3.0") lines.push("PRODID:-//Flowplan//Contacts//DE");
  if (contact.uid) lines.push(`UID:${version === "4.0" && /^[0-9a-f-]{36}$/i.test(contact.uid) ? `urn:uuid:${contact.uid}` : escapeText(contact.uid)}`);
  lines.push(`FN:${escapeText(fn)}`);
  lines.push(`N:${escapeText(contact.lastName)};${escapeText(contact.firstName)};;;`);
  if (contact.org) lines.push(`ORG:${escapeText(contact.org)}`);
  if (contact.title) lines.push(`TITLE:${escapeText(contact.title)}`);
  for (const e of contact.emails) lines.push(`EMAIL${version === "3.0" ? ";TYPE=INTERNET" : ""}${typeParam(e.type, version)}:${escapeText(e.value)}`);
  for (const p of contact.phones) lines.push(`TEL${typeParam(p.type, version)}:${escapeText(p.value)}`);
  for (const a of contact.addresses)
    lines.push(`ADR${typeParam(a.type, version)}:;;${[a.street, a.city, a.region, a.postalCode, a.country].map(escapeText).join(";")}`);
  if (contact.birthday) lines.push(`BDAY:${contact.birthday.startsWith("--") ? contact.birthday.replace(/^--(\d{2})-(\d{2})$/, "--$1$2") : contact.birthday}`);
  if (contact.categories.length) lines.push(`CATEGORIES:${contact.categories.map(escapeText).join(",")}`);
  if (contact.url) lines.push(`URL:${escapeText(contact.url)}`);
  if (contact.note) lines.push(`NOTE:${escapeText(contact.note)}`);
  if (contact.photo)
    lines.push(
      version === "4.0"
        ? `PHOTO:data:${contact.photo.mime};base64,${contact.photo.base64}`
        : `PHOTO;ENCODING=b;TYPE=${contact.photo.mime === "image/png" ? "PNG" : "JPEG"}:${contact.photo.base64}`,
    );
  lines.push("END:VCARD");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
export function serializeVCards(contacts: VCardContact[], version: "3.0" | "4.0" = "3.0") {
  return contacts.map((c) => serializeVCard(c, version)).join("");
}
