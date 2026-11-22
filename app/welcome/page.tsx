import type { Metadata } from "next";
import WelcomePassword from "@/components/welcome-password";
import { serverT } from "@/lib/i18n-server";
import { welcomeAccount } from "@/lib/account-create";
import { instanceSettings } from "@/lib/instance-settings";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await serverT())("Passwort festlegen · Flowplan", "Set your password · Flowplan"),
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}
// The link of an account an administrator created (#433,
// lib/account-create.ts): the token is only looked at here; setting the
// password uses it up and signs the person in.
export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const account = await welcomeAccount(token);
  return <WelcomePassword token={account ? token : ""} account={account} instanceName={(await instanceSettings()).name} />;
}
