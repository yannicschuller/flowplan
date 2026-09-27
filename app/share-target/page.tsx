import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { ShareTarget } from "@/components/share-target";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "In Flowplan speichern" };

// Target of "Teilen" on phones (manifest share_target). Only shows what
// arrived; saving is a normal, origin-checked command.
export default async function ShareTargetPage({
  searchParams,
}: {
  searchParams: Promise<{ title?: string; text?: string; url?: string }>;
}) {
  const shared = await searchParams;
  const pick = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const input = { title: pick(shared.title, 300), text: pick(shared.text, 20_000), url: pick(shared.url, 2000) };
  if (!(await currentUser())) {
    const query = new URLSearchParams(Object.entries(input).filter(([, v]) => v)).toString();
    redirect(`/api/auth/login?returnTo=${encodeURIComponent(`/share-target?${query}`)}`);
  }
  return <ShareTarget {...input} />;
}
