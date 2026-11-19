"use client";
// Administration → KI: provider, who may use AI and which features exist,
// the prices for the cost estimate, the quotas (#382) – and the statistics
// of AI use.
import { AdminAi } from "../../ai-settings";
import { useAdmin } from "../admin-context";
import { AiQuotasSection } from "./ai-quotas";
import { AiStatisticsSection } from "./ai-statistics";

export default function AdminAiSection() {
  const { load, onError } = useAdmin();
  // AdminAi loads its own data; a change also refreshes /api/admin (the AI
  // switches in the user list depend on it).
  return (
    <>
      <AdminAi onError={onError} onChange={load} />
      <AiQuotasSection />
      <AiStatisticsSection />
    </>
  );
}
