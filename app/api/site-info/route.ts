import { NextResponse } from "next/server";
import { loginOptions } from "@/lib/local-auth";
import { demoEnabled } from "@/lib/demo";
import { readOnlyState } from "@/lib/instance-read-only";

// Public facts about this instance: whether sign-up and the demo are open
// (administration), and its new address after an instance move (the apps
// can point there). Without personal data.
export const dynamic = "force-dynamic";
export async function GET() {
  const options = await loginOptions();
  return NextResponse.json(
    { signupOpen: options.signupOpen || (!options.localLogin && options.configured), demo: demoEnabled(), sso: options.configured, movedTo: readOnlyState().movedTo, readOnly: readOnlyState().readOnly },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" } },
  );
}
