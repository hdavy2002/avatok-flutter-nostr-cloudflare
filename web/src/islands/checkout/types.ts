/* Phase B — local checkout types. These mirror the EXACT Worker shapes read
 * from worker/src/routes/calendar.ts, avavoice.ts and wallet.ts (read-only).
 * They live here (not in the shared lib) because they are checkout-internal.
 */

/** A real, bookable calendar slot row — GET /api/calendar/slots?host=<creator>. */
export interface CalendarSlot {
  id: string;
  host_uid: string;
  title: string;
  description?: string | null;
  start_at: number;
  end_at: number;
  /** Price in AvaCoins (1 coin = 1 cent). 0 = free. */
  price_coins: number;
  capacity: number;
  booked_count: number;
  status: 'open' | 'closed' | 'cancelled' | string;
}

/** What the picker hands up to the BookingFlow. */
export type BookSelection =
  | {
      type: 'calendar'; // consult / event / live ticket — POST /api/calendar/book
      slotId: string;
      title: string;
      startAt: number;
      endAt: number;
      /** Known up-front for calendar slots. */
      requiredCoins: number;
    }
  | {
      type: 'agent'; // AI agent session — POST /api/avavoice/bookings
      agentId: string;
      minutes: number;
      scheduledAt: number;
      language: string;
      title: string;
      /** Escrow is computed server-side; unknown until we try (402 → needed). */
      requiredCoins: number | null;
    };

/** Result returned by the booking endpoints. */
export interface BookingResult {
  ok?: boolean;
  booking_id: string;
  start_at?: number;
  end_at?: number;
  paid?: boolean;
  escrow_coins?: number;
}

/** Balance shape from POST-less GET /api/wallet/balance (walletOp body). */
export interface WalletBalance {
  balance?: number;
  [k: string]: unknown;
}

/** Top-up response — POST /api/wallet/topup. */
export interface TopupResult {
  checkout_url: string;
  session_id: string;
  topup_id: string;
}

export type Step = 'pick' | 'identify' | 'pay' | 'confirm';
