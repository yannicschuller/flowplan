// JSON answers from a model: asked for, parsed robustly, checked against a
// schema, retried once with the problem named – and never executed. The
// result is plain data; callers still validate everything they store.
import type { z } from "zod";
import { HttpError } from "../auth";
import type { Identity } from "../types";
import type { AiFeature } from "./features";
import { aiComplete, type AiRunInput, type AiRunOptions } from "./run";

export const AI_INVALID_JSON = "Die KI hat keine verwertbare Antwort geliefert. Bitte erneut versuchen.";

// The first JSON object or array in a model's answer: code fences, text
// around it and trailing commas are tolerated. Throws when there is none.
export function extractJson(text: string): unknown {
  let body = text.trim();
  const fenced = body.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) body = fenced[1].trim();
  // Objects first: prose like "see [1]" before the answer is no array.
  const starts = [...body.matchAll(/[{[]/g)].map((m) => m.index!);
  const ordered = [...starts.filter((i) => body[i] === "{"), ...starts.filter((i) => body[i] === "[")].slice(0, 40);
  for (const start of ordered)
    try {
      return balanced(body, start);
    } catch {}
  throw new SyntaxError("no JSON");
}
function balanced(body: string, start: number): unknown {
  const open = body[start],
    close = open === "{" ? "}" : "]";
  // The matching end, respecting strings.
  let depth = 0,
    inString = false,
    escaped = false,
    end = -1;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0 || body[end] !== close) throw new SyntaxError("unbalanced JSON");
  const candidate = body.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Trailing commas, a frequent slip.
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
  }
}

// Parses and validates; null when either fails (with the reason).
export function parseJsonAnswer<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; problem: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return { ok: false, problem: "Die Antwort enthielt kein gültiges JSON." };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, problem: `Das JSON passt nicht zum Schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(Wurzel)"}: ${i.message}`).join("; ")}` };
  return { ok: true, value: parsed.data };
}

// Asks for JSON and returns it validated. On an invalid answer the model
// gets one more chance with the problem named; then a 502.
export async function aiJson<T>(
  user: Identity,
  feature: AiFeature,
  input: AiRunInput,
  schema: z.ZodType<T>,
  options: AiRunOptions = {},
): Promise<T> {
  const first = await aiComplete(user, feature, { temperature: 0.2, ...input }, options);
  const parsed = parseJsonAnswer(first, schema);
  if (parsed.ok) return parsed.value;
  const retry = await aiComplete(
    user,
    feature,
    {
      ...input,
      temperature: 0,
      messages: [
        ...input.messages,
        { role: "assistant", content: first.slice(0, 4000) || "(leer)" },
        { role: "user", content: `${parsed.problem} Antworte noch einmal, ausschließlich mit gültigem JSON nach der Vorgabe, ohne weiteren Text.` },
      ],
    },
    options,
  );
  const second = parseJsonAnswer(retry, schema);
  if (second.ok) return second.value;
  throw new HttpError(502, AI_INVALID_JSON);
}
