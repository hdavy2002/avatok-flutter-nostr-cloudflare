/* [AUMFE-VOICE-WEB-1] Authed calls for the voice call screen. Same pattern as the Dashboard 2 islands:
 * request() from lib/apiClient (reports api_error itself) + the Clerk/guest token from lib/clerk. */
import { ApiError, request } from '../../lib/apiClient';
import { getActiveTokenWaited } from '../../lib/clerk';
import type {
  AgentSessionRow, AgentsResponse, AstroProfile, MemoryItem, TicketResponse,
} from './types';

const GUEST_JWT_KEY = 'saathum_guest_jwt';

export class SignedOutError extends Error {
  constructor() { super('Please sign in again.'); this.name = 'SignedOutError'; }
}

export async function authToken(): Promise<string | null> {
  const t = await getActiveTokenWaited(6000);
  if (t) return t;
  try { return localStorage.getItem(GUEST_JWT_KEY); } catch { return null; }
}

async function authed<T>(path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const auth = await authToken();
  if (!auth) throw new SignedOutError();
  return request<T>(path, { timeoutMs: 20_000, ...opts, auth });
}

export function errCode(e: unknown): string | undefined {
  return e instanceof ApiError ? e.error : undefined;
}

export function errStatus(e: unknown): number | undefined {
  return e instanceof ApiError ? e.status : undefined;
}

/** The worker's own message when it sent one. */
export function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object') {
    const m = (e.body as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  if (e instanceof TypeError) return 'You seem to be offline. Check your connection and try again.';
  return fallback;
}

export const getAgents = () => authed<AgentsResponse>('/api/voice/agents');
export const getTicket = (agent: string) => authed<TicketResponse>('/api/voice/ticket', { method: 'POST', body: { agent } });

export async function getProfile(): Promise<AstroProfile | null> {
  const r = await authed<{ profile: AstroProfile | null }>('/api/me/astro-profile');
  return r.profile ?? null;
}

export interface ProfileInput {
  name: string; dob: string; tob: string | null; tob_unknown: boolean; place: string;
}
export const saveProfile = (p: ProfileInput) =>
  authed<{ profile: AstroProfile }>('/api/me/astro-profile', { method: 'PUT', body: p });

export const saveConsent = (consent: boolean) =>
  authed<{ profile: AstroProfile }>('/api/me/memory-consent', { method: 'POST', body: { consent } });

export async function getSessions(): Promise<AgentSessionRow[]> {
  const r = await authed<{ sessions: AgentSessionRow[] }>('/api/me/agent-sessions');
  return r.sessions ?? [];
}

export async function getMemories(): Promise<MemoryItem[]> {
  const r = await authed<{ memories: MemoryItem[] }>('/api/me/memories');
  return r.memories ?? [];
}

export const deleteMemory = (id: string) =>
  authed<{ ok: boolean }>(`/api/me/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
