import type { Metadata } from "next";
import { PresenterView } from "@/components/presenter-view";
import { serverT } from "@/lib/i18n-server";

// Rendered per request: the scripts need the nonce of proxy.ts.
export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverT())("Referentenansicht", "Presenter view") };
}

// The presenter view of a presentation (components/presentation.tsx). It
// shows only what the presentation in the other window sends over its
// BroadcastChannel, so it needs no data of its own.
export default async function PresenterPage({ searchParams }: { searchParams: Promise<{ deck?: string | string[] }> }) {
  const { deck } = await searchParams;
  const id = typeof deck === "string" && /^[0-9a-f-]{36}$/i.test(deck) ? deck : "";
  return <PresenterView deckId={id} />;
}
