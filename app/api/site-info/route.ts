import { NextResponse } from "next/server";
import { loginOptions } from "@/lib/local-auth";
import { demoEnabled } from "@/lib/demo";

// What the website (flowplan.org) may offer: sign-up and the demo follow the
// administration's switches. Public, without personal data.
export const dynamic = "force-dynamic";
export function GET() {
  const options = loginOptions();
  return NextResponse.json(
    { signupOpen: options.signupOpen || (!options.localLogin && options.configured), demo: demoEnabled(), sso: options.configured },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" } },
  );
}
