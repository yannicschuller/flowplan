// Where the apps are: the iPhone and iPad beta on TestFlight, the Android
// APK straight from flowplan.org (it updates itself) and the download page.
export const TESTFLIGHT_URL = "https://testflight.apple.com/join/Yjy9aZAE";
export const ANDROID_APK_URL = "https://flowplan.org/download/android.apk";
export const DOWNLOAD_URL = "https://flowplan.org/download";

export type PhoneSystem = "ios" | "android";

// The phone or tablet a browser runs on, from its user agent (iPadOS
// names itself a Mac with a touch screen).
export function phoneSystem(
  userAgent: string,
  touchPoints = 0,
): PhoneSystem | null {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Macintosh/.test(userAgent) && touchPoints > 1) return "ios";
  return null;
}
