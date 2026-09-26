import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import Login from "@/components/login";
import { instanceSettings } from "@/lib/instance-settings";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Anmelden · Flowplan" };
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
