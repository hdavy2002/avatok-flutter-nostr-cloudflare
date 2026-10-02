/* [AUMFE-GUIDES-FRONT-1] Shared API helper for the "Talk to a guide" sections (home ad band + Explore).
 * Reuses the voice island's auth + agents call; adds the wallet balance. Tokens are rupees (1 token = Rs 1). */
import { request } from '../../lib/apiClient';
import { authToken, getAgents } from '../voice/api';

export interface GuideAgent {
  id: string; name: string; subject: string; initial: string; tint: string; blurb: string;
  /** Rupees per minute when the API sent one. */
  price: number | null;
}

export interface GuidesData { agents: GuideAgent[]; price: number | null }

/** GET /api/voice/agents, read tolerantly: agents[].price_per_min_tokens, else agents[].price_per_min_paise / 100,
 *  else the top-level price_per_min_paise / 100. */
export async function loadGuides(): Promise<GuidesData> {
  const r = await getAgents();
  const top = typeof r.price_per_min_paise === 'number' ? r.price_per_min_paise / 100 : null;
  const agents = (r.agents ?? []).map((a): GuideAgent => {
    const x = a as unknown as { price_per_min_tokens?: number; price_per_min_paise?: number };
    const price = typeof x.price_per_min_tokens === 'number' ? x.price_per_min_tokens
      : typeof x.price_per_min_paise === 'number' ? x.price_per_min_paise / 100 : top;
    return { id: a.id, name: a.name, subject: a.subject, initial: a.initial, tint: a.tint, blurb: a.blurb, price };
  });
  return { agents, price: agents[0]?.price ?? top };
}

/** GET /api/wallet/balance -> spendable ?? balance, in tokens (= rupees). Null when it cannot be read. */
export async function loadBalance(): Promise<number | null> {
  const auth = await authToken();
  if (!auth) return null;
  const r = await request<{ balance?: number; spendable?: number }>('/api/wallet/balance', { auth, timeoutMs: 12_000 });
  const n = Number(r.spendable ?? r.balance);
  return Number.isFinite(n) ? n : null;
}

export const rupees = (n: number) => '₹' + (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Subjects shown as "Coming soon" until the API returns an agent for them (mockup order). */
export const SOON = [
  { subject: 'Palmistry', name: 'Kavya', initial: 'K', tint: '#c82c25', blurb: 'Show your palm on camera; she reads lines, mounts and hand type.' },
  { subject: 'Numerology', name: 'Arjun', initial: 'A', tint: '#8a5a12', blurb: 'Your name and birth numbers, lucky days, colours and name changes.' },
  { subject: 'Tarot', name: 'Tara', initial: 'T', tint: '#5b3f8c', blurb: 'One clear question, three cards, a gentle answer.' },
  { subject: 'Marriage', name: 'Sneha', initial: 'S', tint: '#a8326e', blurb: 'Kundli milan, guna points, Manglik check for two people.' },
  { subject: 'Vastu', name: 'Dev', initial: 'D', tint: '#3f6b2e', blurb: 'Room by room, or share your floor plan; score and simple remedies.' },
] as const;

export const soonFor = (agents: GuideAgent[]) =>
  SOON.filter((s) => !agents.some((a) => a.subject.toLowerCase().includes(s.subject.toLowerCase())));

export const isAstro = (a: GuideAgent) => /astrolog/i.test(a.subject) || a.id === 'astrology';
