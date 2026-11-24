// The answer that ends the session of this device (#501): the browser drops
// its HTTP cache of the instance, so no answer of the signed-out person is
// served from it. Only "cache": "storage" would also wipe localStorage and
// IndexedDB – changes made offline and not sent yet (components/sign-out.ts)
// – and unregister the service worker. The offline copy in Cache Storage is
// removed by the app itself (components/sign-out.ts → disableOffline).
export const SIGNED_OUT_HEADERS: Record<string, string> = { "Clear-Site-Data": '"cache"' };
