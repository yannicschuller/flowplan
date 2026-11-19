"use client";
// Settings → KI: what is left of the AI quota (#382), one's AI features, an
// own provider and what the AI may read.
import { UserAiSettings } from "../../ai-settings";
import { AiQuotaBars } from "../../ai-quota-bars";
import { useUserSettings } from "../user-context";

export default function AiSection() {
  const { boot, onError, onRefresh } = useUserSettings();
  return (
    <>
      {!boot.user.demo && <AiQuotaBars />}
      <UserAiSettings boot={boot} onError={onError} onRefresh={onRefresh} />
    </>
  );
}
