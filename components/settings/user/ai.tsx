"use client";
// Settings → KI: one's AI features, an own provider and what the AI may read.
import { UserAiSettings } from "../../ai-settings";
import { useUserSettings } from "../user-context";

export default function AiSection() {
  const { boot, onError, onRefresh } = useUserSettings();
  return <UserAiSettings boot={boot} onError={onError} onRefresh={onRefresh} />;
}
