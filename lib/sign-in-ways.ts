// Which ways the sign-in page offers and which of them comes first
// (components/login.tsx): one large button for the way last used on this
// device, the others below it. On a first visit single sign-on comes first
// where the instance has it, then passkeys, then e-mail and password. Ways
// the instance has turned off are not offered at all.
export type SignInWay = "sso" | "passkey" | "password";

export const LAST_SIGN_IN_KEY = "flowplan:last-sign-in";
const ORDER: SignInWay[] = ["sso", "passkey", "password"];

export const isSignInWay = (value: unknown): value is SignInWay => ORDER.includes(value as SignInWay);

// What the instance and this browser allow:
// - sso: OIDC is set up (OIDC_ISSUER);
// - passkey: accounts of the instance (FLOWPLAN_LOCAL_LOGIN) and passkeys in
//   this browser – or the app, which hands passkeys over to the system browser;
// - password: accounts of the instance or the LDAP directory.
export function availableSignInWays(flags: { sso: boolean; passkey: boolean; password: boolean }): SignInWay[] {
  return ORDER.filter((way) => flags[way]);
}

export type SignInChoice = {
  // The large button; null when the instance offers no way at all.
  main: SignInWay | null;
  // The main way is the one last used on this device ("Zuletzt verwendet").
  lastUsed: boolean;
  // Outlined buttons below the main one (never the password: it has its own
  // text button that opens the form).
  secondary: SignInWay[];
  // "Mit E-Mail und Passwort" below the buttons (the form is not the main way).
  passwordLink: boolean;
};

export function chooseSignInWays(available: SignInWay[], last: unknown): SignInChoice {
  const remembered = isSignInWay(last) && available.includes(last) ? last : null;
  const main = remembered || available[0] || null;
  return {
    main,
    lastUsed: !!remembered,
    secondary: available.filter((way) => way !== main && way !== "password"),
    passwordLink: main !== "password" && available.includes("password"),
  };
}

// The way last used on this device; storage may be blocked (private
// windows, strict settings): then it is a first visit every time.
export function readLastSignIn(storage?: Pick<Storage, "getItem">): SignInWay | null {
  try {
    const value = (storage ?? localStorage).getItem(LAST_SIGN_IN_KEY);
    return isSignInWay(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeLastSignIn(way: SignInWay | null, storage?: Pick<Storage, "setItem" | "removeItem">) {
  try {
    const target = storage ?? localStorage;
    if (way) target.setItem(LAST_SIGN_IN_KEY, way);
    else target.removeItem(LAST_SIGN_IN_KEY);
  } catch {}
}
