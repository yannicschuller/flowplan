import type { Metadata } from "next";
import ResetPassword from "@/components/reset-password";
import { serverT } from "@/lib/i18n-server";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await serverT())("Neues Passwort · Flowplan", "New password · Flowplan"),
    referrer: "no-referrer",
  };
}
export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  return <ResetPassword token={(await searchParams).token || ""} />;
}
