import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { demoEnabled } from "@/lib/demo";
import { serverT } from "@/lib/i18n-server";
import { DemoStart } from "@/components/demo-start";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverT())("Demo · Flowplan", "Demo · Flowplan") };
}
// "Demo ausprobieren" on the website leads here; the demo account is created
// by a request from this page (same origin).
export default async function DemoPage() {
  if (await currentUser()) redirect("/");
  if (!demoEnabled()) redirect("/login");
  return <DemoStart />;
}
