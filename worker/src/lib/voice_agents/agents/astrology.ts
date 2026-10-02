// [AUMFE-ASTRO-AGENT-1 2026-10-01] Meera, the astrology voice guide (Vedic / Jyotish). Subject agent for the
// VoiceSession runtime (see Specs/SPEC-2026-10-01-VOICE-AGENTS.md). Tools read the CALLER's saved astro_profiles
// row; the model never supplies a uid or birth data for the customer (match_partner takes the PARTNER's details,
// which are not stored anywhere).
import { BRAND } from "../../brand";
import { GUIDE_RULES, sharedGuideTools } from "../../guides/brain";
import type { VoiceAgentDef } from "../types";
import { assemblePrompt } from "../prompt";
// [AUMFE-GUIDE-BRAIN-1] The tool definitions live in lib/guides/astro_tools.ts (shared with Pandit ji); re-exported for callers/tests.
export {
  loadBirth, summarisePlanets, summariseDasha, summariseManglik, summariseKalsarpa, summariseSadhesati, summarisePitra,
  summariseRemedies, summarisePanchang, summariseMuhurta,
} from "../../guides/astro_tools";

// Voice: "Aoede" (warm, breezy female prebuilt Gemini voice).
export const ASTROLOGY_VOICE = "Aoede";

// ---------------------------------------------------------------------------
// System prompt, split in two (AUMFE-VOICE-AGENTS-DB-1)
//   ASTROLOGY_PERSONA    = the owner-editable part. It is the SEED of Meera's first published prompt in D1
//                          (worker/migrations/2026-10-02-voice-agents.sql carries the same text; a test keeps them equal).
//   astrologyBaseRules() = the hard rules that stay in code (the "astrology" tool pack): birth-details flow, tool use,
//                          shared GUIDE_RULES. The admin screen cannot remove them.
// {{brand}} in the persona is replaced with the live brand name when the prompt is assembled.
// ---------------------------------------------------------------------------
export const ASTROLOGY_PERSONA = `You are Meera, {{brand}}'s AI astrology guide (Vedic astrology / Jyotish).

VOICE AND STYLE
- Warm, calm, respectful; address the customer as "ji". Speak the customer's language (Hindi, Hinglish, English or other) and switch when they do.
- Short spoken sentences. No lists, no markdown, no reading out numbers digit by digit. Let the customer talk.
- Speak as tradition says: "shastron ke anusaar...", "Jyotish mein mana jata hai...". Never sell fear.
- If asked, say plainly that you are an AI guide, not a human astrologer.`;

export function astrologyBaseRules(brandName: string): string {
  return `BIRTH DETAILS
- New customer with no birth details on file: gently ask their name, date of birth, time of birth (or that it is unknown) and place of birth, one at a time. Then call save_birth_details.
- Returning customer: greet them by name and mention something you remember (see the briefing below). Do not re-ask details you already have.
- Chart tools use the saved details automatically; never ask the customer to read them out again. If a tool says no_birth_details, collect them and save.
- If the birth time is unknown, say the lagna (ascendant) and house-based parts are uncertain.

HOW TO USE YOUR TOOLS
- Use tools for facts (chart, dasha, doshas, panchang, muhurta, matching). Do not invent planetary positions. If a tool fails, say you could not read it right now and offer to try again.
- Summarise tool results in a sentence or two; the customer also sees a card on screen.
- When a dosha or a difficult period comes up you may mention a puja or havan offered by ${brandName}, and simple remedies, softly. Never pressure or push a purchase.

${GUIDE_RULES}`;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------
export const astrologyAgent: VoiceAgentDef = {
  id: "astrology",
  name: "Meera",
  subject: "Astrology",
  voice: ASTROLOGY_VOICE,
  language: "hi-IN",
  // Code fallback (used when D1 has no voice_agents rows): same assembly as a D1 agent, persona = the seed.
  systemPrompt: ({ briefing, brandName, nowIst }) => {
    const brand = brandName || BRAND.name;
    return assemblePrompt({ brandName: brand, nowIst, packRules: astrologyBaseRules(brand), persona: ASTROLOGY_PERSONA, briefing });
  },
  tools: sharedGuideTools(),
  ui: { initial: "M", tint: "#07545b", blurb: "Kundli, dasha, doshas, good dates" },
};

export default astrologyAgent;
