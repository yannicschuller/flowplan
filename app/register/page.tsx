import type { Metadata } from "next";
import { legalLinks } from "@/lib/legal-links";
import { sourceUrl } from "@/lib/about";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { clientAddress } from "@/lib/client-address";
import { currentUser } from "@/lib/auth";
import Login from "@/components/login";
import { loginOptions } from "@/lib/local-auth";
import { instanceSettings } from "@/lib/instance-settings";
import { serverT } from "@/lib/i18n-server";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return {
    title: t("Konto erstellen · Flowplan", "Create account · Flowplan"),
    description: t("Erstelle ein Flowplan-Konto: Dokumente, Datenbanken, Whiteboards und Journal in einem Arbeitsbereich.", "Create a Flowplan account: documents, databases, whiteboards and a journal in one workspace."),
    alternates: { canonical: "/register" },
    robots: { index: true, follow: true },
  };
}
// Creating an account; where sign-ups are closed (and no invitation link
// came along) the page offers signing in.
export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ setup?: string; invite?: string; join?: string }> }) {
  if (await currentUser()) redirect("/");
  const { setup, invite, join } = await searchParams;
  const options = await loginOptions(setup, invite, join, clientAddress(await headers()));
  return (
    <Login
        legal={legalLinks()}
      {...options}
      mode={options.signupOpen ? "register" : "signin"}
      instanceName={(await instanceSettings()).name}
      sourceUrl={sourceUrl()}
    />
  );
}
