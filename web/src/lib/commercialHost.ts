/*
 * Browser creator controls for the commercial live-event lane.
 *
 * The Worker is the session authority. This module only calls its existing
 * prepare-host, go-live, end and state endpoints. In particular, it never
 * derives a GetStream call type or call id from a listing id.
 */
import { request } from './apiClient';
import type { CommercialJoinCredentials } from './getstream';

export interface CommercialHostCredentials extends CommercialJoinCredentials {
  lane?: 'commercial' | string;
  provider?: 'getstream' | string;
  kind?: 'live_event' | string;
  title?: string;
  opens_at?: number;
  closes_at?: number;
  expires_at_ms?: number;
  token_expires_at?: number;
}

export type CommercialHostStateName =
  | 'scheduled'
  | 'backstage'
  | 'live'
  | 'ending'
  | 'ended'
  | 'cancelled'
  | 'reconciliation_pending'
  | string;

export interface CommercialHostState {
  ok?: boolean;
  session_id?: string;
  kind?: string;
  listing_id?: string;
  state: CommercialHostStateName;
  settlement_state?: string;
  scheduled_at?: number;
  live_started_at?: number | null;
  ended_at?: number | null;
  starts_at?: number;
  ends_at?: number;
}

export interface CommercialHostControlResult {
  ok?: boolean;
  state: 'starting' | 'ending' | 'ended' | string;
  idempotent_replay?: boolean;
}

function livePath(listingId: string, action: string): string {
  return `/api/commercial/live/${encodeURIComponent(listingId)}/${action}`;
}

/** Prepare a private host backstage session and return server-issued credentials. */
export function prepareCommercialLiveHost(
  listingId: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<CommercialHostCredentials> {
  return request<CommercialHostCredentials>(livePath(listingId, 'prepare-host'), {
    method: 'POST',
    auth: jwt,
    signal,
  });
}

/** Request the provider-backed broadcast to start. */
export function goLiveCommercial(
  listingId: string,
  jwt: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<CommercialHostControlResult> {
  return request<CommercialHostControlResult>(livePath(listingId, 'go-live'), {
    method: 'POST',
    auth: jwt,
    headers: { 'Idempotency-Key': idempotencyKey },
    signal,
  });
}

/** Request the provider-backed broadcast to end. */
export function endCommercialLive(
  listingId: string,
  jwt: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<CommercialHostControlResult> {
  return request<CommercialHostControlResult>(livePath(listingId, 'end'), {
    method: 'POST',
    auth: jwt,
    headers: { 'Idempotency-Key': idempotencyKey },
    signal,
  });
}

/** Read the authoritative lifecycle state. Never infer live status from SDK state. */
export function commercialLiveHostState(
  listingId: string,
  jwt: string,
  signal?: AbortSignal,
): Promise<CommercialHostState> {
  return request<CommercialHostState>(livePath(listingId, 'state'), {
    auth: jwt,
    signal,
  });
}

/** One key per lifecycle operation; reuse it when retrying that operation. */
export function newHostIdempotencyKey(prefix: 'go-live' | 'end'): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

