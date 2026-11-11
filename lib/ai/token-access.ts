// API tokens and AI (#199): a token reaches the AI features, transcription
// and meeting notes only when it was created with the permission "KI und
// Transkription" (lib/api-tokens.ts, off unless chosen) and the
// administration has not switched that off for the instance (Administration
// → KI, `tokens`). Browser sessions are not affected. Everything else about
// tokens stays as it is: read tokens only read, clipper tokens only clip.
import { HttpError } from "../auth";
import type { Identity } from "../types";
import { instanceAiSettings, type AiInstanceSettings } from "./settings";

export const TOKEN_AI_MISSING = "Dieses API-Token hat keine Berechtigung „KI und Transkription“.";
export const TOKEN_AI_OFF = "KI und Transkription sind für API-Tokens auf dieser Instanz ausgeschaltet.";

// Synchronous with the instance settings at hand (lib/ai/resolve.ts).
export function tokenAiAllowed(user: Pick<Identity, "apiScope" | "apiAi">, instance: Pick<AiInstanceSettings, "tokens">) {
  if (!user.apiScope) return true;
  return user.apiScope !== "clipper" && !!user.apiAi && instance.tokens !== false;
}

// Throws for a token without the permission (or while the administration
// switched it off); a browser session always passes. Demo accounts are
// refused by the callers as before.
export async function requireTokenAi(user: Pick<Identity, "apiScope" | "apiAi">) {
  if (!user.apiScope) return;
  if (user.apiScope === "clipper" || !user.apiAi) throw new HttpError(403, TOKEN_AI_MISSING);
  if ((await instanceAiSettings()).tokens === false) throw new HttpError(403, TOKEN_AI_OFF);
}
