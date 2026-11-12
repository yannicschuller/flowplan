// All marketplace-only official templates (see ./types.ts). Imported by
// lib/marketplace-official.ts only – never by client code.
import { extraAppearances } from "./appearances";
import { extraDatabases } from "./databases";
import { extraDocuments } from "./documents";
import { extraLinkRules } from "./link-rules";
import type { ExtraItem } from "./types";
import { extraWhiteboards } from "./whiteboards";
import { extraWorkflows } from "./workflows";

export type { ExtraItem } from "./types";
export const extraOfficial: ExtraItem[] = [...extraDocuments, ...extraDatabases, ...extraWhiteboards, ...extraWorkflows, ...extraAppearances, ...extraLinkRules];
