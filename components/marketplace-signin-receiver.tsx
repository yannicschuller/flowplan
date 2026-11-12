"use client";
// The marketplace receiver on the sign-in page, loaded only when the page was
// opened for a hand-over (#marketplace-import): the sign-in page has a tight
// JavaScript budget (scripts/quality-check.mjs) and almost every visit there
// has nothing to do with the marketplace.
import { useEffect, useState, type ComponentType } from "react";
import type { MarketplaceClientConfig } from "@/lib/marketplace-config";

type Receiver = ComponentType<{ config: MarketplaceClientConfig | null }>;

export function MarketplaceSignInReceiver({ config }: { config: MarketplaceClientConfig | null }) {
  const [Receiver, setReceiver] = useState<Receiver | null>(null);
  useEffect(() => {
    if (!config || !location.hash.startsWith("#marketplace-import")) return;
    let live = true;
    void import("./marketplace").then((m) => {
      if (live) setReceiver(() => m.MarketplaceReceiver as Receiver);
    });
    return () => {
      live = false;
    };
  }, [config]);
  return Receiver ? <Receiver config={config} /> : null;
}
