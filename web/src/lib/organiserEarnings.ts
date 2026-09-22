/**
 * Illustrative organiser earnings planner (A6.1, D1). Pure math only — no
 * network calls, no wallet/billing/PRICING/ledger access. See
 * Specs/saathum-home-v2/contracts.md §4 for the fee constants and canonical
 * sentence this module implements.
 */

export const SLOT_MINUTES = 30;
export const TIME_FEE_PER_SLOT_INR = 50; // ₹100 per hour, per participant
export const PLATFORM_SHARE = 0.2; // of the organiser's price A; independent of event length
export const SLOT_CHOICES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8]; // 30 min … 4 h

export interface EarningsPlanInputs {
  /** Number of 30-minute slots booked (1–8). */
  slots: number;
  /** Organiser's price per participant (₹), before the platform's time fee. */
  priceA: number;
  /** Paid participants. */
  participants: number;
  /** Host/venue/other costs for the event (₹). */
  costs: number;
}

export interface EarningsPlanResult {
  hours: number;
  /** Platform time fee per participant (= 50 * slots). */
  baseFee: number;
  /** What a participant pays: baseFee + priceA. */
  ticketPrice: number;
  platformCommissionPerAttendee: number;
  organiserPerAttendee: number;
  ticketSales: number;
  platformBaseTotal: number;
  platformCommission: number;
  /** Organiser proceeds before other costs (never "take-home"). */
  organiserProceeds: number;
  /** organiserProceeds - costs. May be negative. */
  estimatedRemainder: number;
  /** True when priceA is 0 — the organiser hasn't added anything for themself or their host. */
  zeroPriceNote: boolean;
}

export type TicketPriceResolution =
  | { valid: true; priceA: number }
  | { valid: false; minimumTicket: number; message: string };

export function hoursForSlots(slots: number): number {
  return slots / 2;
}

export function baseForSlots(slots: number): number {
  return TIME_FEE_PER_SLOT_INR * slots;
}

/** "30 min", "1 h", "1.5 h", … — the event-length select option label (A6.2). */
export function labelForSlots(slots: number): string {
  const hours = hoursForSlots(slots);
  if (hours < 1) return `${slots * SLOT_MINUTES} min`;
  return `${formatHours(hours)} h`;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function roundInr(value: number): number {
  return Math.round(value);
}

export function computeEarningsPlan(inputs: EarningsPlanInputs): EarningsPlanResult {
  const { slots, priceA, participants, costs } = inputs;
  const hours = hoursForSlots(slots);
  const baseFee = baseForSlots(slots);
  const ticketPrice = baseFee + priceA;
  const platformCommissionPerAttendee = roundInr(PLATFORM_SHARE * priceA);
  const organiserPerAttendee = roundInr(priceA - PLATFORM_SHARE * priceA);
  const ticketSales = roundInr(participants * ticketPrice);
  const platformBaseTotal = roundInr(participants * baseFee);
  const platformCommission = roundInr(participants * PLATFORM_SHARE * priceA);
  const organiserProceeds = roundInr(participants * (priceA - PLATFORM_SHARE * priceA));
  const estimatedRemainder = organiserProceeds - costs;

  return {
    hours,
    baseFee,
    ticketPrice,
    platformCommissionPerAttendee,
    organiserPerAttendee,
    ticketSales,
    platformBaseTotal,
    platformCommission,
    organiserProceeds,
    estimatedRemainder,
    zeroPriceNote: priceA === 0,
  };
}

/**
 * Resolves the organiser's price A from a typed ticket price T (the linked
 * second field, A6.1). Never clamps a loss into a positive number: if
 * `ticketPrice` is below the platform's base time fee, the result is invalid
 * and must be suppressed by the caller.
 */
export function resolvePriceFromTicketPrice(slots: number, ticketPrice: number): TicketPriceResolution {
  const base = baseForSlots(slots);
  const priceA = ticketPrice - base;
  if (priceA < 0) {
    return {
      valid: false,
      minimumTicket: base,
      message: `The minimum ticket for a ${formatHours(hoursForSlots(slots))}-hour event is ₹${base}`,
    };
  }
  return { valid: true, priceA };
}

export type PlannerOutcome =
  | { status: 'ok'; plan: EarningsPlanResult }
  | { status: 'invalid'; minimumTicket: number; message: string };

export type PlannerParams = { slots: number; participants: number; costs: number } & (
  | { mode: 'price'; priceA: number }
  | { mode: 'ticket'; ticketPrice: number }
);

/** Single entry point for the linked A/T inputs (A6.1, A6.2). */
export function planEarnings(params: PlannerParams): PlannerOutcome {
  if (params.mode === 'ticket') {
    const resolved = resolvePriceFromTicketPrice(params.slots, params.ticketPrice);
    if (!resolved.valid) {
      return { status: 'invalid', minimumTicket: resolved.minimumTicket, message: resolved.message };
    }
    return {
      status: 'ok',
      plan: computeEarningsPlan({
        slots: params.slots,
        priceA: resolved.priceA,
        participants: params.participants,
        costs: params.costs,
      }),
    };
  }
  return {
    status: 'ok',
    plan: computeEarningsPlan({
      slots: params.slots,
      priceA: params.priceA,
      participants: params.participants,
      costs: params.costs,
    }),
  };
}

/** Indian digit grouping, whole rupees (A6.2). */
export function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);
}
