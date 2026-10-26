// AI: running prompts for features, the person's AI settings, and the
// administration's connection tests and model downloads (lib/ai). Every
// route needs a browser session; API tokens and demo accounts are refused,
// changes also need the origin check. Keys never appear in an answer.
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { limitAiSetup } from "@/lib/action-limits";
import { requireAdmin, requireMember } from "@/lib/permissions";
import type { Identity } from "@/lib/types";
import { AI_FEATURE_IDS, AI_REASON_TEXT } from "@/lib/ai/features";
import { aiBlockInfo, aiPageAccess, aiRules } from "@/lib/ai/access";
import { aiStatus, instanceProviderConfig, userProviderConfig } from "@/lib/ai/resolve";
import { aiStreamResponse, AI_LIMITS } from "@/lib/ai/run";
import { listModels, pullModel, testConnection } from "@/lib/ai/providers";
import { adminAiView, assertSettingsCaller, instanceAiSettings, userAiSettings, userKeyInfo } from "@/lib/ai/settings";
import { redactSecrets } from "@/lib/ai/redact";
import { askInput, prepareAsk, NOTHING_FOUND } from "@/lib/ai/ask";
import { semanticStats } from "@/lib/ai/semantic";
import { aiDatabaseStatus, proposeDatabase, queueAiCells, runAiCell } from "@/lib/ai/database";
import { ct } from "@/lib/content-locale";
import { aiWriteResponse, WRITE_LIMITS } from "@/lib/ai/write";
import { aiSummaryResponse, SUMMARY_LIMITS } from "@/lib/ai/summarize";
import { ACTION_LIMITS, proposeActions, runActions, type ProposeInput } from "@/lib/ai/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(e: unknown) {
  if (e instanceof z.ZodError)
    return NextResponse.json({ error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) }, { status: 400 });
  if (!(e instanceof HttpError)) console.error("KI:", redactSecrets(String((e as Error)?.message || e)));
  return NextResponse.json(
    { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
    { status: e instanceof HttpError ? (e.status === 499 ? 400 : e.status) : 500 },
  );
}
const noStore = { headers: { "Cache-Control": "no-store" } };

async function signedIn() {
  const user = await requireUser();
  assertSettingsCaller(user);
  return user;
}
// A small JSON body, read with a limit.
async function body(req: Request, limit: number) {
  if (Number(req.headers.get("content-length") || 0) > limit) throw new HttpError(413, "Anfrage zu groß.");
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, "Anfrage zu groß.");
  try {
    return JSON.parse(text || "{}") as unknown;
  } catch {
    throw new HttpError(400, "Ungültige Eingabe.");
  }
}
function built(result: ReturnType<typeof instanceProviderConfig>) {
  if (!result.ok) throw new HttpError(409, AI_REASON_TEXT[result.reason][0]);
  return result.config;
}

// What the settings page shows: the person's choices, their own provider
// without its key (only "stored · …abcd"), their rules and the status.
function settingsView(user: Identity, workspaceId: string | null) {
  const instance = instanceAiSettings();
  return {
    settings: userAiSettings(user.id),
    key: userKeyInfo(user.id),
    rules: aiRules(user, workspaceId || undefined),
    status: aiStatus(user, workspaceId || undefined),
    instance: {
      enabled: instance.enabled,
      userProviders: instance.userProviders,
      provider: !!instance.provider,
      features: Object.fromEntries(AI_FEATURE_IDS.map((id) => [id, instance.features[id] !== false])),
      device: instance.device,
    },
  };
}

export const GET = withRequestLocale(handleGET);
async function handleGET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await params;
    const url = new URL(req.url);
    const user = await signedIn();
    if (path.length === 1 && path[0] === "settings") {
      const workspace = url.searchParams.get("workspace");
      if (workspace) requireMember(user, z.uuid().parse(workspace));
      return NextResponse.json(settingsView(user, workspace), noStore);
    }
    if (path.length === 1 && path[0] === "access") {
      const row = url.searchParams.get("row");
      return NextResponse.json(aiPageAccess(user, z.uuid().parse(url.searchParams.get("page")), row ? z.uuid().parse(row) : null), noStore);
    }
    if (path.length === 1 && path[0] === "block")
      return NextResponse.json(
        {
          ...aiBlockInfo(user, z.uuid().parse(url.searchParams.get("target")), z.enum(["page", "space"]).parse(url.searchParams.get("kind"))),
          enabled: instanceAiSettings().enabled,
        },
        noStore,
      );
    if (path.length === 1 && path[0] === "admin") {
      requireAdmin(user);
      return NextResponse.json({ ...adminAiView(), semantic: semanticStats() }, noStore);
    }
    // AI in a database: values waiting to be computed, and when and with
    // which model each value was computed.
    if (path.length === 2 && path[0] === "database" && path[1] === "status")
      return NextResponse.json(aiDatabaseStatus(user, z.uuid().parse(url.searchParams.get("page"))), noStore);
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    return error(e);
  }
}

const runInput = z.object({
  feature: z.enum(AI_FEATURE_IDS as [string, ...string[]]),
  workspaceId: z.uuid(),
  pageId: z.uuid().optional(),
  rowId: z.uuid().optional(),
  system: z.string().max(AI_LIMITS.maxPromptChars).optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1).max(AI_LIMITS.maxMessages),
  maxTokens: z.number().int().min(1).max(AI_LIMITS.maxTokens).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const POST = withRequestLocale(handlePOST);
async function handlePOST(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    checkOrigin(req);
    const { path } = await params;
    const user = await signedIn();
    // A prompt for a feature, answered as a text stream.
    if (path.length === 1 && path[0] === "run") {
      const b = runInput.parse(await body(req, AI_LIMITS.maxPromptChars * 4 + 100_000));
      requireMember(user, b.workspaceId);
      return await aiStreamResponse(
        user,
        b.feature as (typeof AI_FEATURE_IDS)[number],
        { system: b.system, messages: b.messages, maxTokens: b.maxTokens, temperature: b.temperature },
        { workspaceId: b.workspaceId, pageId: b.pageId, rowId: b.rowId, signal: req.signal },
      );
    }
    // "Ask the workspace": sources in a header (base64 JSON), the answer as
    // a text stream like /api/ai/run.
    if (path.length === 1 && path[0] === "ask") {
      const b = askInput.parse(await body(req, 200_000));
      requireMember(user, b.workspaceId);
      const prepared = await prepareAsk(user, b, req.signal);
      const sources = Buffer.from(JSON.stringify(prepared.sources)).toString("base64");
      if (prepared.nothing)
        return new Response(ct(NOTHING_FOUND[0], NOTHING_FOUND[1]), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Flowplan-Sources": sources, "X-Content-Type-Options": "nosniff" },
        });
      const response = await aiStreamResponse(
        user,
        "ask",
        { system: prepared.system, messages: prepared.messages, maxTokens: 1500, temperature: 0.2 },
        { workspaceId: b.workspaceId, signal: req.signal },
      );
      response.headers.set("X-Flowplan-Sources", sources);
      if (prepared.semantic) response.headers.set("X-Flowplan-Semantic", "1");
      return response;
    }
    // AI actions: a checked preview of what the model proposes, then the
    // confirmed actions run as the person (lib/ai/actions.ts).
    if (path.length === 2 && path[0] === "actions") {
      if (path[1] === "propose")
        return NextResponse.json(await proposeActions(user, (await body(req, ACTION_LIMITS.context * 4 + 100_000)) as ProposeInput, req.signal), noStore);
      if (path[1] === "run") return NextResponse.json(runActions(user, await body(req, 2_000_000)), noStore);
    }
    // AI in databases.
    if (path.length === 2 && path[0] === "database") {
      if (path[1] === "propose") {
        const b = z.object({ workspaceId: z.uuid(), description: z.string().trim().min(3).max(2000) }).parse(await body(req, 20_000));
        return NextResponse.json({ proposal: await proposeDatabase(user, b.workspaceId, b.description, req.signal) }, noStore);
      }
      if (path[1] === "cell") {
        const b = z
          .object({ pageId: z.uuid(), fieldId: z.string().min(1).max(500), rowId: z.uuid(), mode: z.enum(["compute", "fill"]) })
          .parse(await body(req, 10_000));
        return NextResponse.json(await runAiCell(user, b.pageId, b.fieldId, b.rowId, b.mode, req.signal), noStore);
      }
      if (path[1] === "queue") return NextResponse.json(queueAiCells(user, await body(req, 100_000)), noStore);
    }
    // The writing assistant: an action on the selection or a free prompt;
    // the prompt is built on the server (lib/ai/write.ts).
    if (path.length === 1 && path[0] === "write")
      return await aiWriteResponse(user, await body(req, (WRITE_LIMITS.maxText + WRITE_LIMITS.maxInstruction) * 4 + 10_000), req.signal);
    // A summary of a page, record, database view or transcript; the content
    // is loaded on the server (lib/ai/summarize.ts).
    if (path.length === 1 && path[0] === "summarize")
      return await aiSummaryResponse(user, await body(req, SUMMARY_LIMITS.maxText * 4 + 20_000 * 40), req.signal);
    // The person's own provider (as saved): test it, list its models.
    if (path.length === 1 && (path[0] === "test" || path[0] === "models")) {
      limitAiSetup(user.id);
      const config = built(userProviderConfig(user));
      if (path[0] === "models") return NextResponse.json({ models: await listModels(config, req.signal) }, noStore);
      return NextResponse.json(await testConnection(config, req.signal), noStore);
    }
    // The administration: the instance provider as saved.
    if (path.length === 2 && path[0] === "admin") {
      requireAdmin(user);
      limitAiSetup(user.id);
      const config = built(instanceProviderConfig());
      if (path[1] === "test") return NextResponse.json(await testConnection(config, req.signal), noStore);
      if (path[1] === "models") return NextResponse.json({ models: await listModels(config, req.signal) }, noStore);
      // Downloading a model into Ollama: progress as JSON lines.
      if (path[1] === "pull") {
        const { model } = z
          .object({ model: z.string().trim().min(1).max(200).regex(/^[\w.\-:/@]+$/, "Ungültiger Modellname.") })
          .parse(await body(req, 10_000));
        const progress = pullModel(config, model, req.signal)[Symbol.asyncIterator]();
        const first = await progress.next();
        const encoder = new TextEncoder();
        const line = (data: unknown) => encoder.encode(JSON.stringify(data) + "\n");
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            if (first.done) {
              c.enqueue(line({ status: "success" }));
              c.close();
            } else c.enqueue(line(first.value));
          },
          async pull(c) {
            if (first.done) return;
            try {
              const next = await progress.next();
              if (next.done) return c.close();
              c.enqueue(line(next.value));
            } catch (e) {
              if (!req.signal.aborted) c.enqueue(line({ error: e instanceof HttpError ? e.message : "Herunterladen fehlgeschlagen." }));
              c.close();
            }
          },
          cancel() {
            void progress.return?.(undefined);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
      }
    }
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    return error(e);
  }
}
