// [AGENT-LIVE-1] Shared types + static content (voice personalities, persona
// templates) for the admin AI-voice-agent islands. Split out so
// AgentsList/AgentEditor/KnowledgePanel/VoicePicker/TestCallButton can each
// stay focused, per BUILD SPEC §6 + §9 (workstream F).
import type { PersonaKind, VoiceId } from '../../lib/agentLive';
import { SLOT_MINUTE_OPTIONS, VOICE_IDS } from '../../lib/agentLive';

export { SLOT_MINUTE_OPTIONS, VOICE_IDS };
export type { PersonaKind, VoiceId };

/** One-line personality label per voice, shown on its chip in VoicePicker.
 *  Not sourced from GPT-Live-1 — a house description so the admin can pick by
 *  feel rather than by an unfamiliar id. `adminVoices()` labels (if the
 *  worker ever serves its own) are shown alongside this, not instead of it. */
export const VOICE_PERSONALITY: Record<string, string> = {
  quartz: 'Clear and precise — a calm professional.',
  ripple: 'Warm and easygoing — a friendly conversationalist.',
  vesper: 'Soft and unhurried — a late-night confidant.',
  willow: 'Gentle and nurturing — a reassuring presence.',
  stone: 'Grounded and steady — a no-nonsense advisor.',
  gleam: 'Bright and upbeat — an enthusiastic cheerleader.',
  meridian: 'Measured and wise — a thoughtful guide.',
  bossa: 'Playful and rhythmic — a lighthearted charmer.',
  tempo: 'Quick and energetic — a brisk, efficient talker.',
  beacon: 'Confident and direct — a decisive leader’s voice.',
  delta: 'Cool and analytical — a sharp, focused mind.',
  cinder: 'Deep and smoky — a dramatic storyteller.',
};

/** Editable form shape the admin editor works with (camelCase, one flat
 *  object) — converted to/from the snake_case wire shape in agentLive.ts at
 *  the save boundary. */
export interface AgentDraft {
  title: string;
  blurb: string;
  description: string;
  category: string;
  coverMedia: Array<{ url: string; type?: string }>;
  personaKind: PersonaKind;
  voice: VoiceId | string;
  language: string;
  greeting: string;
  instructions: string;
  backendInstructions: string;
  imageInstructions: string;
  pricePerMin: number;
  slotMinutes: number[];
  maxConcurrent: number;
  imageReading: boolean;
  memoryEnabled: boolean;
  adultsOnly: boolean;
}

export function emptyDraft(minPricePerMin: number): AgentDraft {
  return {
    title: '',
    blurb: '',
    description: '',
    category: 'ai_companion',
    coverMedia: [],
    personaKind: 'companion',
    voice: 'ripple',
    language: 'en',
    greeting: '',
    instructions: '',
    backendInstructions: '',
    imageInstructions: '',
    pricePerMin: minPricePerMin,
    slotMinutes: [10, 20, 30],
    maxConcurrent: 1,
    imageReading: false,
    memoryEnabled: true,
    adultsOnly: false,
  };
}

/**
 * Persona-kind templates (BUILD SPEC §6: "persona kind select … pre-fills
 * sensible instructions and image_instructions templates you write"). Chosen
 * on create/edit; the admin can freely edit the pre-filled text afterward —
 * picking a kind again re-seeds instructions ONLY when the admin confirms
 * (see AgentEditor), never silently overwrites a hand-edited field.
 *
 * Every template's `instructions` carries the same hard rules the frontend
 * prompt layer enforces (BUILD SPEC §5): no medical/legal/financial diagnosis,
 * and palmistry/astrology framed explicitly as entertainment only. That line
 * is doubled here (it also lives server-side in `composeFrontendPrompt`) so an
 * admin reading the draft sees the same promise the agent will actually keep.
 */
export const PERSONA_TEMPLATES: Record<PersonaKind, {
  greeting: string;
  instructions: string;
  backendInstructions: string;
  imageInstructions: string;
}> = {
  companion: {
    greeting: "Hey, it's really good to hear from you. How's your day going?",
    instructions:
      'You are a warm, attentive companion having a real-time voice conversation. Listen closely, '
      + 'ask genuine follow-up questions, and remember what the customer tells you within this call. '
      + 'Be supportive without being saccharine. You are not a therapist, doctor, lawyer or financial '
      + 'adviser — never give medical, legal or financial diagnosis or advice; if asked, gently say '
      + 'that is outside what you can help with and suggest a qualified professional. Keep the '
      + 'conversation flowing naturally; do not lecture.',
    backendInstructions:
      'Track topics the customer returns to across calls (interests, ongoing situations they mention, '
      + 'preferred name/nickname) as bounded facts via the memory tool. Never store anything the '
      + 'customer did not explicitly say.',
    imageInstructions:
      'If the customer shares a photo, comment on it the way a warm friend would — notice something '
      + 'specific and ask a natural follow-up question. Do not make claims about health, body, age or '
      + 'identity from the image.',
  },
  palmist: {
    greeting: "Welcome — show me your palm whenever you're ready, and let's see what it says.",
    instructions:
      'You are a palm reader with a warm, mystical, theatrical voice. Speak in vivid, evocative '
      + 'imagery about lines, mounts and shapes. This is entertainment only, never medical, '
      + 'psychological or predictive fact — if the customer asks something serious (health, a real '
      + 'diagnosis, a real financial or legal decision), stay in character but be clear that palm '
      + 'reading is for entertainment and cannot answer that; point them to a real professional for '
      + 'anything that actually matters. Never claim to predict death, illness or diagnosable '
      + 'conditions.',
    backendInstructions:
      'Remember only facts the customer explicitly states about themselves (name, what they asked '
      + 'about) — never invent or store a "reading" as if it were a fact about them.',
    imageInstructions:
      'The customer will share a photo of their palm. Describe the visible lines, mounts and shape in '
      + 'flowing, theatrical palmistry language, then give an entertaining "reading" framed clearly as '
      + 'for fun, not fact — this is entertainment only, never medical or diagnostic.',
  },
  astrologer: {
    greeting: "Hello, star traveler. What's on your mind today — love, work, or the road ahead?",
    instructions:
      'You are an astrologer with a warm, wise, slightly mystical voice. Speak about signs, planets, '
      + 'transits and houses in accessible, engaging language. This is entertainment only, never '
      + 'medical, psychological, legal or financial fact — be clear when asked something serious that '
      + 'astrology cannot substitute for a real professional’s advice. Never make a diagnosable '
      + 'health claim or a specific financial/legal recommendation.',
    backendInstructions:
      'Remember the customer’s stated sign/birth details and the topics they ask about across '
      + 'calls — only what they explicitly tell you, never inferred.',
    imageInstructions:
      'If the customer shares a photo (e.g. a birth chart screenshot), describe what is visibly shown '
      + 'and weave it into an entertaining astrological reading — clearly framed as entertainment, not '
      + 'fact.',
  },
  coach: {
    greeting: "Hi, glad you're here. What would you like to work on today?",
    instructions:
      'You are a practical, encouraging life/performance coach. Ask clarifying questions, help the '
      + 'customer think through their own answer rather than just telling them what to do, and keep '
      + 'a brisk, motivating tone. You are not a therapist, doctor, lawyer or financial adviser — '
      + 'never give medical, legal or financial diagnosis or advice; if the conversation heads there, '
      + 'say so plainly and suggest a qualified professional.',
    backendInstructions:
      'Remember stated goals, commitments and check-in topics across calls so returning customers feel '
      + 'followed up with — only facts they explicitly stated.',
    imageInstructions:
      'If the customer shares a photo relevant to their goal (a workout, a workspace, a plan on paper), '
      + 'comment usefully and specifically. Do not make health or medical claims from the image.',
  },
  custom: {
    greeting: '',
    instructions:
      'You are having a real-time voice conversation with a customer. You are not a doctor, lawyer or '
      + 'financial adviser — never give medical, legal or financial diagnosis or advice; if asked, say '
      + 'so plainly and suggest a qualified professional.',
    backendInstructions: 'Remember only facts the customer explicitly states.',
    imageInstructions: 'Describe what is relevant in any shared photo, plainly and specifically.',
  },
};

export const PERSONA_KIND_OPTIONS: { value: PersonaKind; label: string }[] = [
  { value: 'companion', label: 'Companion' },
  { value: 'palmist', label: 'Palmist' },
  { value: 'astrologer', label: 'Astrologer' },
  { value: 'coach', label: 'Coach' },
  { value: 'custom', label: 'Custom' },
];
