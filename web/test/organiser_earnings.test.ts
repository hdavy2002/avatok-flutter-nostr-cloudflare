// [SHV2-S7] A6.3 earnings-planner test vectors, verbatim.
//
// node:test based, matching the convention already used by this repo's
// web/test/ (see device_checks.test.ts, sendMail.test.ts, calendar_core.test.ts
// — there is no vitest devDependency in web/package.json). Run with:
//   cd web && node --experimental-strip-types --test test/organiser_earnings.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeEarningsPlan,
  labelForSlots,
  planEarnings,
  resolvePriceFromTicketPrice,
  SLOT_CHOICES,
} from '../src/lib/organiserEarnings.ts';

// Every row of the A6.3 test-vector table (Specs/saathum-spec-v2-and-agent-plan.md),
// verbatim. slots = H * 2 (30-minute slots).
const VECTORS = [
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

for (const v of VECTORS) {
  test(`A6.3 vector: A=${v.a} N=${v.n} H=${v.h}`, () => {
    const slots = v.h * 2;
    const plan = computeEarningsPlan({ slots, priceA: v.a, participants: v.n, costs: 0 });
    assert.equal(plan.hours, v.h);
    assert.equal(plan.ticketPrice, v.ticket);
    assert.equal(plan.ticketSales, v.ticketSales);
    assert.equal(plan.platformBaseTotal, v.platformBase);
    assert.equal(plan.platformCommission, v.commission);
    assert.equal(plan.organiserProceeds, v.organiserProceeds);
  });
}

test('A=0 shows the zero-price note', () => {
  const plan = computeEarningsPlan({ slots: 2, priceA: 0, participants: 50, costs: 0 });
  assert.equal(plan.zeroPriceNote, true);
  assert.equal(plan.organiserProceeds, 0);
});

test('N=0: ticket sales and proceeds are 0, remainder = −C', () => {
  const plan = computeEarningsPlan({ slots: 2, priceA: 400, participants: 0, costs: 0 });
  assert.equal(plan.ticketSales, 0);
  assert.equal(plan.organiserProceeds, 0);
  assert.equal(plan.estimatedRemainder, 0);

  const withCosts = computeEarningsPlan({ slots: 2, priceA: 400, participants: 0, costs: 3_000 });
  assert.equal(withCosts.organiserProceeds, 0);
  assert.equal(withCosts.estimatedRemainder, -3_000);
});

test('negative remainder is shown, never clamped', () => {
  const plan = computeEarningsPlan({ slots: 2, priceA: 100, participants: 5, costs: 10_000 });
  // organiserProceeds = 5 * 80 = 400; remainder = 400 - 10,000 = -9,600
  assert.equal(plan.organiserProceeds, 400);
  assert.equal(plan.estimatedRemainder, -9_600);
});

test('T=150 typed at H=2 is invalid and suppressed, never clamped', () => {
  const resolved = resolvePriceFromTicketPrice(4, 150);
  assert.equal(resolved.valid, false);
  if (!resolved.valid) {
    assert.equal(resolved.minimumTicket, 200);
    assert.equal(resolved.message, 'The minimum ticket for a 2-hour event is ₹200');
  }

  const outcome = planEarnings({ mode: 'ticket', slots: 4, ticketPrice: 150, participants: 50, costs: 0 });
  assert.equal(outcome.status, 'invalid');
});

test('typing a valid ticket price resolves A = T - base', () => {
  const outcome = planEarnings({ mode: 'ticket', slots: 2, ticketPrice: 500, participants: 50, costs: 0 });
  assert.equal(outcome.status, 'ok');
  if (outcome.status === 'ok') {
    assert.equal(outcome.plan.ticketPrice, 500);
    assert.equal(outcome.plan.organiserProceeds, 16_000);
  }
});

test('typing the exact base ticket price resolves A = 0, not invalid', () => {
  const resolved = resolvePriceFromTicketPrice(2, 100);
  assert.deepEqual(resolved, { valid: true, priceA: 0 });
});

test('price mode is equivalent to typing the matching ticket price', () => {
  const byPrice = planEarnings({ mode: 'price', slots: 3, priceA: 400, participants: 50, costs: 0 });
  const byTicket = planEarnings({ mode: 'ticket', slots: 3, ticketPrice: 550, participants: 50, costs: 0 });
  assert.deepEqual(byPrice, byTicket);
});

test('labelForSlots produces the A6.2 select labels for every slot choice', () => {
  assert.deepEqual(SLOT_CHOICES.map(labelForSlots), ['30 min', '1 h', '1.5 h', '2 h', '2.5 h', '3 h', '3.5 h', '4 h']);
});
