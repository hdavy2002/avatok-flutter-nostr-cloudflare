// [AUMFE-VOICE-AGENTS-DB-1 2026-10-02] Tool packs: the CODE half of a voice guide. A guide row in D1 (voice_agents)
// names one pack; the pack supplies the tools (real code that calls APIs) and the hard rules that go with them.
// The owner edits persona, voice, price and knowledge files in admin; he cannot add tools, only pick a pack.
//
// Adding a pack (numerology, tarot, marriage, palmistry, vastu ...): write its tools, add one entry to TOOL_PACKS
// below with its base rules. No other file changes; the admin dropdown reads listToolPacks().
import { sharedGuideTools } from "../guides/brain";
import type { VoiceTool } from "./types";
import { astrologyBaseRules } from "./agents/astrology";

export interface VoiceToolPack {
  id: string;
  label: string;
  description: string;
  /** API tools this pack gives the guide. The runtime adds remember/recall and (when files are ready) search_knowledge. */
  tools: VoiceTool[];
  /** Hard rules that travel with the tools. Never editable from admin. */
  baseRules(brandName: string): string;
}

export const DEFAULT_TOOL_PACK = "knowledge_only";

function knowledgeOnlyRules(): string {
  return `KNOWLEDGE
- You have no chart or catalog tools. Answer from your persona and from search_knowledge (when you have it), and say plainly when you do not know something.
- Never invent facts, sources, prices or products.`;
}

// Built lazily: sharedGuideTools() constructs fresh tool objects, and tests that mock modules rely on import-time laziness.
let astrologyTools: VoiceTool[] | null = null;

export const TOOL_PACKS: Record<string, VoiceToolPack> = {
  astrology: {
    id: "astrology",
    label: "Astrology (Vedic)",
    description: "Kundli, dasha, doshas, remedies, panchang, muhurta, partner matching, shop and puja search.",
    get tools() { return (astrologyTools ??= sharedGuideTools()); },
    baseRules: astrologyBaseRules,
  },
  knowledge_only: {
    id: "knowledge_only",
    label: "Knowledge only",
    description: "No API tools. The guide talks from its persona and the files you upload.",
    tools: [],
    baseRules: () => knowledgeOnlyRules(),
  },
  // Later packs: numerology, tarot, marriage, palmistry, vastu.
};

export function getToolPack(id: unknown): VoiceToolPack | null {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(TOOL_PACKS, id) ? TOOL_PACKS[id] : null;
}

/** Pack to use for a row: its named pack, else knowledge_only (an unknown name never crashes a call). */
export function packOrDefault(id: unknown): VoiceToolPack {
  return getToolPack(id) ?? TOOL_PACKS[DEFAULT_TOOL_PACK];
}

export function listToolPacks(): { id: string; label: string; description: string; tools: string[] }[] {
  return Object.values(TOOL_PACKS).map((p) => ({ id: p.id, label: p.label, description: p.description, tools: p.tools.map((t) => t.decl.name) }));
}
