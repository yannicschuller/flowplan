// The admin API for hosted offerings (lib/admin-api.ts): 404 unless
// FLOWPLAN_ADMIN_API_TOKEN is set. Only forwards the request.
import { adminApi } from "@/lib/admin-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => adminApi(request);
export const PUT = (request: Request) => adminApi(request);
export const POST = (request: Request) => adminApi(request);
export const DELETE = (request: Request) => adminApi(request);
export const PATCH = (request: Request) => adminApi(request);
