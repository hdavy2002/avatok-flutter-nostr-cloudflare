// [AUMFE-POD-FULFIL-1] Pure rules: partner status mapping, money-state derivation, production/can_send, backoff, placement.
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS, deriveMoney, deriveProduction, mapPartnerState, maskVpa, nextAttemptAt, placementForPartner, pollDue, sendBlockedReason,
  type MoneyState, type SendContext,
} from './pod_fulfil_logic';

const NOW = 1_800_000_000_000;
const base = {
  pay_status: 'confirmed' as const, confirm_source: 'sms_auto' as string | null, paid_claimed_at: null as number | null, utr: '123456784821' as string | null,
  payer_reference: null as string | null, payer_vpa: 'ravi.kumar@okaxis' as string | null, expires_at: NOW + 1000, reason_code: null as string | null,
  amount_paise: 94_300, confirmed_at: NOW - 5000 as number | null, email_sent_at: null as number | null,
};
const sms = { amount_paise: 94_300, received_at_ms: NOW - 6000, bank_reference: '123456784821', payer_vpa: 'ravi.kumar@okaxis' };

describe('deriveMoney', () => {
  it('bank confirmed = sms_auto, with SMS amount and time', () => {
    const m = deriveMoney(base, sms, NOW - 1000, NOW);
    expect(m.state).toBe('bank_confirmed');
    expect(m.label).toBe('Paid · bank confirmed ✓');
    expect(m.amount_expected_rupees).toBe(943);
    expect(m.amount_received_rupees).toBe(943);
    expect(m.received_at).toBe(NOW - 6000);
    expect(m.utr_last4).toBe('4821');
    expect(m.payer_vpa_masked).toBe('ravi••@okaxis');
    expect(m.matched).toBe('auto');
    expect(m.buyer_notified_at).toBe(NOW - 1000);
  });
  it('owner confirmed = any other confirm source', () => {
    const m = deriveMoney({ ...base, confirm_source: 'admin' }, null, null, NOW);
    expect(m.state).toBe('owner_confirmed');
    expect(m.label).toBe('Paid · confirmed by you ✓');
    expect(m.amount_received_rupees).toBeNull();
    expect(m.received_at).toBe(NOW - 5000);
    expect(m.matched).toBe('manual');
  });
  it('customer claimed: awaiting with paid_claimed_at or a UTR', () => {
    const a = deriveMoney({ ...base, pay_status: 'awaiting_payment' as never, confirm_source: null, confirmed_at: null, paid_claimed_at: NOW - 60_000, utr: null }, null, null, NOW);
    expect(a.state).toBe('customer_claimed');
    expect(a.matched).toBeNull();
    expect(a.received_at).toBeNull();
    const b = deriveMoney({ ...base, pay_status: 'review_pending' as never, confirm_source: null, confirmed_at: null, paid_claimed_at: null }, null, null, NOW);
    expect(b.state).toBe('customer_claimed');
  });
  it('awaiting, expired, rejected', () => {
    const wait = { ...base, pay_status: 'awaiting_payment' as never, confirm_source: null, confirmed_at: null, utr: null };
    expect(deriveMoney(wait, null, null, NOW).state).toBe('awaiting');
    expect(deriveMoney({ ...wait, expires_at: NOW - 1 }, null, null, NOW).state).toBe('expired');
    expect(deriveMoney({ ...wait, pay_status: 'cancelled' as never, reason_code: 'rejected' }, null, null, NOW).state).toBe('rejected');
    expect(deriveMoney({ ...wait, pay_status: 'cancelled' as never, reason_code: null }, null, null, NOW).state).toBe('expired');
  });
  it('maskVpa never shows the whole handle', () => {
    expect(maskVpa('ab@upi')).toBe('a••@upi');
    expect(maskVpa(null)).toBeNull();
  });
});

describe('mapPartnerState', () => {
  it('printing keeps the order at the printer and sends no new step once there', () => {
    expect(mapPartnerState('sent', 'at_printer', 'printing')).toEqual({ to: 'printing', orderSteps: [], alertOwner: false });
    expect(mapPartnerState('sent', 'new', 'printing').orderSteps).toEqual(['at_printer']);
  });
  it('shipped moves the order once; a repeat poll does nothing', () => {
    expect(mapPartnerState('printing', 'at_printer', 'shipped')).toEqual({ to: 'shipped', orderSteps: ['shipped'], alertOwner: false });
    expect(mapPartnerState('shipped', 'shipped', 'shipped')).toEqual({ to: null, orderSteps: [], alertOwner: false });
  });
  it('a skipped poll still walks shipped then delivered', () => {
    expect(mapPartnerState('printing', 'at_printer', 'delivered')).toEqual({ to: 'delivered', orderSteps: ['shipped', 'delivered'], alertOwner: false });
    expect(mapPartnerState('shipped', 'shipped', 'delivered').orderSteps).toEqual(['delivered']);
  });
  it('never moves backwards', () => {
    expect(mapPartnerState('shipped', 'shipped', 'printing').to).toBeNull();
    expect(mapPartnerState('delivered', 'delivered', 'shipped')).toEqual({ to: null, orderSteps: [], alertOwner: false });
  });
  it('problem and cancelled alert the owner once and touch no order step', () => {
    expect(mapPartnerState('sent', 'at_printer', 'problem')).toEqual({ to: 'problem', orderSteps: [], alertOwner: true });
    expect(mapPartnerState('problem', 'at_printer', 'problem').alertOwner).toBe(false);
    expect(mapPartnerState('printing', 'at_printer', 'cancelled')).toEqual({ to: 'cancelled', orderSteps: [], alertOwner: true });
  });
  it('a problem row that recovers moves forward again', () => {
    expect(mapPartnerState('problem', 'at_printer', 'printing').to).toBe('printing');
  });
});

describe('backoff', () => {
  it('5 min, 30 min, 2 h, then the owner', () => {
    expect([...BACKOFF_MS]).toEqual([300_000, 1_800_000, 7_200_000]);
    expect(nextAttemptAt(1, NOW)).toBe(NOW + 300_000);
    expect(nextAttemptAt(2, NOW)).toBe(NOW + 1_800_000);
    expect(nextAttemptAt(3, NOW)).toBe(NOW + 7_200_000);
    expect(nextAttemptAt(4, NOW)).toBeNull();
    expect(nextAttemptAt(0, NOW)).toBe(NOW + 300_000);
  });
  it('pollDue honours the configured minutes', () => {
    expect(pollDue(null, 30, NOW)).toBe(true);
    expect(pollDue(NOW - 29 * 60_000, 30, NOW)).toBe(false);
    expect(pollDue(NOW - 30 * 60_000, 30, NOW)).toBe(true);
    expect(pollDue(NOW - 90_000, 0, NOW)).toBe(true); // 0 clamps to 1 minute
  });
});

const ctx = (money: MoneyState, over: Partial<SendContext> = {}): SendContext =>
  ({ money, providerLabel: 'Printrove', providerSupportsApi: true, providerId: 'printrove', buildBlocker: null, ...over });

describe('sendBlockedReason / deriveProduction', () => {
  it('only a bank- or owner-confirmed, unsent, buildable order can be sent', () => {
    expect(sendBlockedReason('new', false, null, ctx('bank_confirmed'))).toBeNull();
    expect(sendBlockedReason('new', false, null, ctx('owner_confirmed'))).toBeNull();
    expect(sendBlockedReason('new', false, null, ctx('customer_claimed'))).toMatch(/bank has not confirmed/);
    expect(sendBlockedReason('new', false, null, ctx('awaiting'))).toBe('Waiting for payment.');
    expect(sendBlockedReason('new', false, null, ctx('expired'))).toMatch(/not paid/);
  });
  it('already sent, handled by hand, manual provider, unbuildable', () => {
    expect(sendBlockedReason('at_printer', true, 'sent', ctx('bank_confirmed'))).toMatch(/Already sent/);
    expect(sendBlockedReason('at_printer', false, null, ctx('bank_confirmed'))).toMatch(/by hand/);
    expect(sendBlockedReason('new', false, null, ctx('bank_confirmed', { providerSupportsApi: false }))).toMatch(/not connected/);
    expect(sendBlockedReason('new', false, null, ctx('bank_confirmed', { buildBlocker: 'Tee · Black · L is not linked' }))).toBe('Tee · Black · L is not linked');
  });
  it('a problem row can be sent again', () => {
    expect(sendBlockedReason('new', true, 'problem', ctx('bank_confirmed'))).toBeNull();
  });
  it('production state comes from the fulfilment row, else from the order', () => {
    expect(deriveProduction('new', null, ctx('bank_confirmed')).state).toBe('not_sent');
    expect(deriveProduction('new', null, ctx('bank_confirmed')).can_send).toBe(true);
    const p = deriveProduction('at_printer', { status: 'printing', provider: 'printrove', provider_order_id: '77', courier: null, awb: null, tracking_url: null, last_error: null }, ctx('bank_confirmed'));
    expect(p).toMatchObject({ state: 'printing', provider: 'printrove', provider_order_id: '77', can_send: false });
    expect(deriveProduction('shipped', null, ctx('owner_confirmed'))).toMatchObject({ state: 'shipped', provider: 'manual' });
    const prob = deriveProduction('new', { status: 'problem', provider: 'printrove', provider_order_id: null, courier: null, awb: null, tracking_url: null, last_error: 'bad pin' }, ctx('bank_confirmed'));
    expect(prob).toMatchObject({ state: 'problem', problem: 'bad pin', can_send: true });
  });
});

describe('placementForPartner', () => {
  it('prefers the print PNG box over the frame (art zoomed out is smaller than the frame)', () => {
    expect(placementForPartner({ side: 'front', frame_w_in: 11, frame_h_in: 11, frame_top_in: 2.5, print_w_in: 8, print_h_in: 7.5, print_left_in: 3.8, print_top_in: 4 }, 15.6))
      .toEqual({ side: 'front', width_in: 8, height_in: 7.5, top_in: 4, left_in: 3.8 });
  });
  it('centres the frame on the print area unless a left offset was stored', () => {
    expect(placementForPartner({ side: 'front', frame_w_in: 11, frame_h_in: 11, frame_top_in: 2.5 }, 15.6)).toEqual({ side: 'front', width_in: 11, height_in: 11, top_in: 2.5, left_in: 2.3 });
    expect(placementForPartner({ side: 'back', frame_w_in: 8, frame_h_in: 6, frame_top_in: 1, frame_left_in: 0.5 }, 15.6)).toMatchObject({ side: 'back', left_in: 0.5 });
  });
  it('returns null without a usable frame', () => {
    expect(placementForPartner(null, 15.6)).toBeNull();
    expect(placementForPartner({ side: 'front' }, 15.6)).toBeNull();
    expect(placementForPartner({ frame_w_in: 0, frame_h_in: 5 }, 15.6)).toBeNull();
  });
});
