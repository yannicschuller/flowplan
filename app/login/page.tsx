import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import Login from "@/components/login";
import { instanceSettings } from "@/lib/instance-settings";
import { serverT } from "@/lib/i18n-server";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverT())("Anmelden · Flowplan", "Sign in · Flowplan") };
}
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string }>;
}) {
  if (await currentUser()) redirect("/");
  return (
    <Login
      demo={process.env.NODE_ENV !== "production"}
      configured={!!process.env.OIDC_ISSUER}
      error={(await searchParams).authError}
      instanceName={instanceSettings().name}
    />
  );
}
