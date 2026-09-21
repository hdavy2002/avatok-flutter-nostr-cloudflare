import { describe, expect, it } from 'vitest';
import {
  computeEarningsPlan,
  labelForSlots,
  planEarnings,
  resolvePriceFromTicketPrice,
  SLOT_CHOICES,
} from './organiserEarnings';

// Every row of the A6.3 test-vector table (Specs/saathum-spec-v2-and-agent-plan.md),
// verbatim. slots = H * 2 (30-minute slots).
describe('A6.3 test vectors', () => {
  const vectors: Array<{
    a: number;
    n: number;
    h: number;
    ticket: number;
    ticketSales: number;
    platformBase: number;
    commission: number;
    organiserProceeds: number;
  }> = [
    { a: 400, n: 50, h: 1, ticket: 500, ticketSales: 25_000, platformBase: 5_000, commission: 4_000, organiserProceeds: 16_000 },
    { a: 400, n: 200, h: 1, ticket: 500, ticketSales: 1_00_000, platformBase: 20_000, commission: 16_000, organiserProceeds: 64_000 },
    { a: 400, n: 1_000, h: 1, ticket: 500, ticketSales: 5_00_000, platformBase: 1_00_000, commission: 80_000, organiserProceeds: 3_20_000 },
    { a: 100, n: 50, h: 1, ticket: 200, ticketSales: 10_000, platformBase: 5_000, commission: 1_000, organiserProceeds: 4_000 },
    { a: 300, n: 50, h: 2, ticket: 500, ticketSales: 25_000, platformBase: 10_000, commission: 3_000, organiserProceeds: 12_000 },
    { a: 500, n: 50, h: 0.5, ticket: 550, ticketSales: 27_500, platformBase: 2_500, commission: 5_000, organiserProceeds: 20_000 },
    { a: 400, n: 50, h: 1.5, ticket: 550, ticketSales: 27_500, platformBase: 7_500, commission: 4_000, organiserProceeds: 16_000 },
    { a: 400, n: 50, h: 2.5, ticket: 650, ticketSales: 32_500, platformBase: 12_500, commission: 4_000, organiserProceeds: 16_000 },
    { a: 0, n: 50, h: 1, ticket: 100, ticketSales: 5_000, platformBase: 5_000, commission: 0, organiserProceeds: 0 },
  ];

  it.each(vectors)('A=%s N=%s H=%s', ({ a, n, h, ticket, ticketSales, platformBase, commission, organiserProceeds }) => {
    const slots = h * 2;
    const plan = computeEarningsPlan({ slots, priceA: a, participants: n, costs: 0 });
    expect(plan.hours).toBe(h);
    expect(plan.ticketPrice).toBe(ticket);
    expect(plan.ticketSales).toBe(ticketSales);
    expect(plan.platformBaseTotal).toBe(platformBase);
    expect(plan.platformCommission).toBe(commission);
    expect(plan.organiserProceeds).toBe(organiserProceeds);
  });

  it('A=0 shows the zero-price note', () => {
    const plan = computeEarningsPlan({ slots: 2, priceA: 0, participants: 50, costs: 0 });
    expect(plan.zeroPriceNote).toBe(true);
    expect(plan.organiserProceeds).toBe(0);
  });

  it('N=0: ticket sales and proceeds are 0, remainder = −C', () => {
    const plan = computeEarningsPlan({ slots: 2, priceA: 400, participants: 0, costs: 0 });
    expect(plan.ticketSales).toBe(0);
    expect(plan.organiserProceeds).toBe(0);
    expect(plan.estimatedRemainder).toBe(0);

    const withCosts = computeEarningsPlan({ slots: 2, priceA: 400, participants: 0, costs: 3_000 });
    expect(withCosts.organiserProceeds).toBe(0);
    expect(withCosts.estimatedRemainder).toBe(-3_000);
  });

  it('negative remainder is shown, never clamped', () => {
    const plan = computeEarningsPlan({ slots: 2, priceA: 100, participants: 5, costs: 10_000 });
    // organiserProceeds = 5 * 80 = 400; remainder = 400 - 10,000 = -9,600
    expect(plan.organiserProceeds).toBe(400);
    expect(plan.estimatedRemainder).toBe(-9_600);
  });

  it('T=150 typed at H=2 is invalid and suppressed, never clamped', () => {
    const resolved = resolvePriceFromTicketPrice(4, 150);
    expect(resolved.valid).toBe(false);
    if (!resolved.valid) {
      expect(resolved.minimumTicket).toBe(200);
      expect(resolved.message).toBe('The minimum ticket for a 2-hour event is ₹200');
    }

    const outcome = planEarnings({ mode: 'ticket', slots: 4, ticketPrice: 150, participants: 50, costs: 0 });
    expect(outcome.status).toBe('invalid');
  });
});

describe('linked A/T inputs', () => {
  it('typing a valid ticket price resolves A = T - base', () => {
    const outcome = planEarnings({ mode: 'ticket', slots: 2, ticketPrice: 500, participants: 50, costs: 0 });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.plan.ticketPrice).toBe(500);
      expect(outcome.plan.organiserProceeds).toBe(16_000);
    }
  });

  it('typing the exact base ticket price resolves A = 0, not invalid', () => {
    const resolved = resolvePriceFromTicketPrice(2, 100);
    expect(resolved).toEqual({ valid: true, priceA: 0 });
  });

  it('price mode is equivalent to typing the matching ticket price', () => {
    const byPrice = planEarnings({ mode: 'price', slots: 3, priceA: 400, participants: 50, costs: 0 });
    const byTicket = planEarnings({ mode: 'ticket', slots: 3, ticketPrice: 550, participants: 50, costs: 0 });
    expect(byPrice).toEqual(byTicket);
  });
});

describe('labelForSlots', () => {
  it('produces the A6.2 select labels for every slot choice', () => {
    expect(SLOT_CHOICES.map(labelForSlots)).toEqual(['30 min', '1 h', '1.5 h', '2 h', '2.5 h', '3 h', '3.5 h', '4 h']);
  });
});
