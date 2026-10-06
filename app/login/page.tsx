import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import Login from "@/components/login";
import { loginOptions } from "@/lib/local-auth";
import { instanceSettings } from "@/lib/instance-settings";
import { serverT } from "@/lib/i18n-server";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return {
    title: t("Anmelden · Flowplan", "Sign in · Flowplan"),
    description: t("Melde dich bei Flowplan an – mit Passkey, Passwort oder Single Sign-on.", "Sign in to Flowplan – with a passkey, password or single sign-on."),
    alternates: { canonical: "/login" },
    robots: { index: true, follow: true },
  };
}
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string }>;
}) {
  if (await currentUser()) redirect("/");
  return (
    <Login
      {...loginOptions()}
      error={(await searchParams).authError}
      instanceName={instanceSettings().name}
    />
  );
}
