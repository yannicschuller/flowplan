// The draw.io Flowplan ships (#454): its web app from vendor/drawio, under
// /drawio/<version>/, with its own Content Security Policy
// (lib/drawio-bundle.ts). The proxy gives these files no policy of its own
// (proxy.ts POLICY_EXCLUDED).
import { drawioFileResponse } from "@/lib/drawio-bundle";

export const runtime = "nodejs";
type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, { params }: Context) {
  return drawioFileResponse(request, (await params).path || []);
}
export async function HEAD(request: Request, { params }: Context) {
  return drawioFileResponse(request, (await params).path || []);
}
