import type { Metadata } from "next";
import { cookies } from "next/headers";
import LinkAccount from "@/components/link-account";
import { pendingLinkInfo } from "@/lib/oidc-link";
import { serverT } from "@/lib/i18n-server";
import { instanceSettings } from "@/lib/instance-settings";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await serverT())("Konto verbinden · Flowplan", "Connect account · Flowplan"),
    referrer: "no-referrer",
  };
}
// A first SSO sign-in whose verified address belongs to an existing account
// (#101, lib/oidc-link.ts): the person proves that account to connect it.
export default async function LinkAccountPage() {
  const info = pendingLinkInfo((await cookies()).get("flowplan_link")?.value);
  return <LinkAccount info={info} instanceName={instanceSettings().name} />;
}
