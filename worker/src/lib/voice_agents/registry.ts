// [AUMFE-VOICE-RUNTIME-1 2026-10-01] The list of voice guides the runtime can open.
// Each subject agent lives in agents/<id>.ts (written by its own lane) and is registered here.
import type { VoiceAgentDef, VoiceAgentPublic } from "./types";
import astrologyAgent from "./agents/astrology";

const AGENTS: VoiceAgentDef[] = [astrologyAgent];

export function getAgent(id: unknown): VoiceAgentDef | null {
  if (typeof id !== "string" || !id) return null;
  return AGENTS.find((a) => a.id === id) ?? null;
}

export function toPublic(a: VoiceAgentDef): VoiceAgentPublic {
  return { id: a.id, name: a.name, subject: a.subject, initial: a.ui.initial, tint: a.ui.tint, blurb: a.ui.blurb };
}

export function listAgentsPublic(): VoiceAgentPublic[] {
  return AGENTS.map(toPublic);
}
