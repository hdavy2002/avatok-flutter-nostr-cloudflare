// [AUMFE-CONSULT-F1-1 2026-10-02] Customer-facing READ calls for the consultant surfaces (lane W1's public.ts).
// Optional auth: a previewer's Clerk token makes the worker show hidden (dark) consultants; everyone else gets the
// public answer (an empty list / 404 while the feature flag is off).
import { request } from '../../lib/apiClient';
import { getActiveToken, getActiveTokenWaited } from '../../lib/clerk';
import { hasClerkSessionHint } from '../../lib/sessionHint';
import type { ConsultantCard, ConsultantDetail, ReviewDTO, SlotDay } from '../../lib/consultTypes';

async function optionalAuth(): Promise<string | null> {
  try {
    // Only wait for Clerk when a session cookie says someone is probably signed in; anonymous visitors never wait.
    return hasClerkSessionHint() ? await getActiveTokenWaited(2500) : await getActiveToken();
  } catch {
    return null;
  }
}

export interface DetailResponse { consultant: ConsultantDetail; reviews: ReviewDTO[]; review_pages: number; sample_reviews: boolean }
export interface ReviewsResponse { reviews: ReviewDTO[]; page: number; pages: number }

export async function fetchList(): Promise<ConsultantCard[]> {
  const r = await request<{ consultants?: ConsultantCard[] }>('/api/consultants/list', { auth: await optionalAuth(), timeoutMs: 15_000 });
  return r.consultants ?? [];
}
export async function fetchDetail(slug: string): Promise<DetailResponse> {
  return request<DetailResponse>(`/api/consultants/c/${encodeURIComponent(slug)}`, { auth: await optionalAuth(), timeoutMs: 15_000 });
}
export async function fetchReviews(slug: string, page: number): Promise<ReviewsResponse> {
  return request<ReviewsResponse>(`/api/consultants/c/${encodeURIComponent(slug)}/reviews`, { auth: await optionalAuth(), query: { page }, timeoutMs: 15_000 });
}
export async function fetchSlots(slug: string, from: string, days: number): Promise<SlotDay[]> {
  const r = await request<{ days?: SlotDay[] }>(`/api/consultants/c/${encodeURIComponent(slug)}/slots`, { auth: await optionalAuth(), query: { from, days }, timeoutMs: 15_000 });
  return r.days ?? [];
}
