import { request } from './apiClient';

/** One account-owned row from GET /api/commercial/sessions/mine. */
export interface CommercialScheduleSession {
  entitlement_id?: string | null;
  kind: 'live_event' | 'consult_1to1' | string;
  listing_id: string;
  booking_id?: string | null;
  order_id?: string | null;
  commercial_session_id?: string | null;
  session_id?: string | null;
  product_id?: string | null;
  title?: string | null;
  role?: 'viewer' | 'buyer' | 'host' | 'creator' | string | null;
  listing_status?: string | null;
  session_state?: string | null;
  booking_status?: string | null;
  order_status?: string | null;
  entitlement_state?: string | null;
  settlement_state?: string | null;
  session_settlement_state?: string | null;
  starts_at?: number | null;
  ends_at?: number | null;
  opens_at?: number | null;
  closes_at?: number | null;
  join_opens_at?: number | null;
  join_closes_at?: number | null;
  server_now?: number | null;
  action?: string | null;
  actions?: string[];
  allowed_actions?: string[];
  counterparty_id?: string | null;
  counterparty_name?: string | null;
  counterparty_avatar_url?: string | null;
  creator_name?: string | null;
  price?: number | null;
  currency_display?: string | null;
  receipt_id?: string | null;
  refund_receipt_id?: string | null;
}

export type CommercialScheduleView = 'all' | 'upcoming' | 'live' | 'past' | 'cancelled';

export interface CommercialScheduleResponse {
  ok?: boolean;
  role: 'customer' | 'creator' | string;
  server_now: number;
  sessions: CommercialScheduleSession[];
  next_cursor?: string | null;
}

export function getCommercialSchedule(
  role: 'customer' | 'creator',
  jwt: string,
  view: CommercialScheduleView = 'all',
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<CommercialScheduleResponse> {
  return request<CommercialScheduleResponse>('/api/commercial/sessions/mine', {
    auth: jwt,
    query: {
      role,
      view,
      filter: view,
      limit: 50,
      cursor: cursor || undefined,
    },
    signal,
  });
}

export type ConfirmationDeliveryStatus = 'queued' | 'provider_accepted' | 'delivered' | 'failed' | 'bounced' | 'unavailable' | string;

export interface ResendConfirmationResponse {
  ok: boolean;
  order_id: string;
  email_status?: string | null;
  delivery_status?: ConfirmationDeliveryStatus | null;
}

export function resendCommercialConfirmation(orderId: string, jwt: string): Promise<ResendConfirmationResponse> {
  return request<ResendConfirmationResponse>(`/api/commercial/orders/${encodeURIComponent(orderId)}/resend-confirmation`, {
    method: 'POST',
    auth: jwt,
  });
}
