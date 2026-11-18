import type { Metadata } from "next";
import AppPasskeyAdd from "@/components/app-passkey-add";
import { serverT } from "@/lib/i18n-server";
import { isAppPasskeyReturn } from "@/lib/app-passkey";
import { appPasskeyTokenAccount } from "@/lib/local-auth";
import { instanceSettings } from "@/lib/instance-settings";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await serverT())("Passkey hinzufügen · Flowplan", "Add a passkey · Flowplan"),
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}
// "Passkey hinzufügen" in the iPhone/iPad/Android app and the desktop app
// (lib/app-passkey.ts): opened in the system's sign-in sheet with the app's
// one-time token and its callback, or in the default browser without one. The token is only looked at here; the button uses it up.
export default async function AppPasskeyAddPage({ searchParams }: { searchParams: Promise<{ token?: string | string[]; return?: string | string[] }> }) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  // The phone app's callback, or none: the desktop app opened the link in
  // the default browser and asks the instance itself (passkey-app-status).
  // A callback anywhere else: nothing is looked up, the page only says so.
  const returnTo = params.return === undefined ? null : typeof params.return === "string" && isAppPasskeyReturn(params.return) ? params.return : false;
  const account = returnTo === false ? null : await appPasskeyTokenAccount(token);
  return <AppPasskeyAdd token={account ? token : ""} returnTo={returnTo} account={account} instanceName={(await instanceSettings()).name} />;
}
