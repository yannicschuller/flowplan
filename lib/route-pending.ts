// The app routes by the address's fragment (#page=…, #settings/…, #admin,
// #inbox …), which the server never sees: it always renders the start page.
// On a reload or a link to another place that start page would show until
// the app has hydrated and switched to the place in the address – a flash
// of the wrong page. ROUTE_PENDING_SCRIPT runs in <head> before the first
// paint (app/layout.tsx) and marks <html data-route-pending="…"> with the
// shape of the place to come; app/globals.css then hides the server's start
// page and shows a placeholder of that shape (components/route-pending.tsx)
// until the workspace has drawn the right screen and calls
// routePendingDone(). Without JavaScript nothing is marked; should the app's
// scripts fail, the stylesheet shows the start page after a few seconds.
export const ROUTE_PENDING_ATTRIBUTE = "data-route-pending";
export type RoutePending = "page" | "settings" | "list";

/** The placeholder a fragment (without "#") waits with, or null for the
 *  start page (no fragment, #home, and what opens over the start page:
 *  #search, #new, #capture, #workspace=…, #search=…). Only a guess of the
 *  shape: the workspace decides (components/workspace-app.tsx) and ends
 *  the wait either way. */
export function routePendingFor(fragment: string): RoutePending | null {
  if (/^page=/.test(fragment)) return "page";
  if (/^(settings|admin)(\/|$)/.test(fragment)) return "settings";
  if (/^(inbox|tasks|graph|trash|media|tags|collection|library)(\/|$)/.test(fragment)) return "list";
  return null;
}

// The same rule as routePendingFor(), written out (tests/route-pending.test.ts
// checks both agree).
export const ROUTE_PENDING_SCRIPT = `(function(){try{var f=location.hash.slice(1),k=/^page=/.test(f)?"page":/^(settings|admin)(\\/|$)/.test(f)?"settings":/^(inbox|tasks|graph|trash|media|tags|collection|library)(\\/|$)/.test(f)?"list":null;if(k)document.documentElement.setAttribute(${JSON.stringify(ROUTE_PENDING_ATTRIBUTE)},k)}catch(e){}})()`;

/** The workspace shows the place in the address: the placeholder goes. */
export function routePendingDone() {
  if (typeof document !== "undefined") document.documentElement.removeAttribute(ROUTE_PENDING_ATTRIBUTE);
}
