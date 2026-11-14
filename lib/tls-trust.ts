// How Flowplan checks the certificates of the SMTP and LDAP servers it
// connects to (#286). Verification is on unless an administrator turns it
// off on purpose; a server addressed by IP or by a name that is not in its
// certificate can be checked against the certificate's name instead.
//
//   SMTP_TLS_CA / LDAP_TLS_CA          own CA (lib/mail.ts, lib/ldap.ts)
//   SMTP_TLS_SERVERNAME / LDAP_TLS_SERVERNAME
//                                      the name the certificate is checked
//                                      against (and sent as SNI) when the
//                                      server is addressed by IP or another name
//   SMTP_TLS_REJECT_UNAUTHORIZED / LDAP_TLS_REJECT_UNAUTHORIZED
//                                      "false" (trimmed, any letter case)
//                                      turns verification off; any other
//                                      value or none keeps it on
//
// Turning it off is never silent: a warning in the server log at start
// (instrumentation.ts), in Administration (E-Mail, Anmeldung & SSO) and in
// the security overview (lib/security-admin.ts).
// No imports beyond node: – instrumentation.ts loads it early.
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

export type TlsService = "SMTP" | "LDAP";

// Only "false" switches verification off – "0", "no" or a typo keep it on.
export const tlsVerifyOff = (service: TlsService) =>
  process.env[`${service}_TLS_REJECT_UNAUTHORIZED`]?.trim().toLowerCase() === "false";
export const tlsServername = (service: TlsService) => process.env[`${service}_TLS_SERVERNAME`]?.trim() || undefined;

// Whether the service is set up at all (a switch without a server is moot).
const configured = (service: TlsService) => !!(service === "SMTP" ? process.env.SMTP_HOST : process.env.LDAP_URL)?.trim();

// The node:tls options for a connection to `host`: SNI (never an IP
// address – Node refuses it), the name the certificate must carry and
// whether a certificate that fails is refused.
export function tlsIdentity(host: string, servername: string | undefined, rejectUnauthorized = true) {
  const name = servername || host;
  return {
    servername: isIP(name) ? undefined : name,
    // An own name: checked against it, whatever address the connection uses.
    ...(servername ? { checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(name, cert) } : {}),
    rejectUnauthorized,
  };
}

// The services whose certificates are not verified right now.
export const unverifiedTls = (): TlsService[] => (["SMTP", "LDAP"] as const).filter((s) => configured(s) && tlsVerifyOff(s));

// A TLS error about the certificate chain (unknown or self-signed CA).
export const certificateProblem = (message: string) =>
  /unable to (verify the first certificate|get local issuer certificate)|self[- ]signed certificate|certificate chain|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED/i.test(message);
// A certificate for another name than the one the server was reached by.
export const hostnameProblem = (message: string) =>
  /ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate'?s altnames|not in the cert'?s (list|altnames)/i.test(message);

// The server log at start, once per process.
export function tlsWarnings() {
  return unverifiedTls().map(
    (s) =>
      `Flowplan: ${s}_TLS_REJECT_UNAUTHORIZED=false – the certificate of the ${s} server is NOT verified. Anyone on the network path can pose as the server and read the ${s} password. Prefer ${s}_TLS_CA (own CA) and ${s}_TLS_SERVERNAME (name in the certificate) (https://docs.flowplan.org/en/${s === "SMTP" ? "configuration-integrations" : "scim-and-ldap"}).`,
  );
}
const runtime = globalThis as unknown as { flowplanTlsWarned?: boolean };
export function warnUnverifiedTlsOnce(log: (line: string) => void = console.warn) {
  if (runtime.flowplanTlsWarned) return 0;
  runtime.flowplanTlsWarned = true;
  const lines = tlsWarnings();
  for (const line of lines) log(line);
  return lines.length;
}
