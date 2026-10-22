"use client";
// Administration → KI: provider, who may use AI and which features exist.
import { AdminAi } from "../../ai-settings";
import { useAdmin } from "../admin-context";

export default function AdminAiSection() {
  const { load, onError } = useAdmin();
  // AdminAi loads its own data; a change also refreshes /api/admin (the AI
  // switches in the user list depend on it).
  return <AdminAi onError={onError} onChange={load} />;
}
