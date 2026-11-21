import type { Metadata } from "next";
import EmailChangeLink from "@/components/email-change-link";
import { serverT } from "@/lib/i18n-server";
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await serverT())("E-Mail-Adresse ändern · Flowplan", "Change e-mail address · Flowplan"),
    referrer: "no-referrer",
  };
}
// The links of a change of the e-mail address (#405, lib/email-change.ts):
// opening the page changes nothing (mail scanners open links too) – its
// button does.
export default async function EmailChangePage({ searchParams }: { searchParams: Promise<{ token?: string; cancel?: string }> }) {
  const params = await searchParams;
  return <EmailChangeLink token={params.token || ""} cancel={!!params.cancel} />;
}
