// [SAATHUM-SHOP-API-ORDERS-1 2026-10-01] Pure rules for Shop orders (no D1).
import { describe, it, expect } from 'vitest';
import {
  newShopOrderId, shopOrderNo, shopReceiptNo, SHOP_ORDER_ID_RE, shopExternalStatus, shopExternalReason, shopStep, shopOpenForMatching,
  canTransition, SHOP_TRANSITIONS, shopReceiptMoney, shopUpiUri, buildShopOrder, reportWindowOpen, istDayStartMs, validHttpUrl, utrLast4,
  SHOP_TAB_SQL, SHOP_TABS, type ShopOrderRow, type ShopFulfilStatus, type ShopAction,
} from './shop_orders_logic';

const MIN = 60_000;
const base = (over: Partial<ShopOrderRow> = {}): ShopOrderRow => ({
  order_id: 'shp_0123456789abcdef0123', order_no: 'SHP-01234567', uid: 'u1', request_key: 'k',
  items_json: JSON.stringify([{ product_id: 'p1', slug: 'om', name: 'Om Tee', colour: 'Black', size: 'M', qty: 2, unit_rupees: 499, amount_rupees: 998, image_url: null }]),
  subtotal_rupees: 998, discount_rupees: 0, coupon_code: null, gst_rate_pct: 18, gst_rupees: 180, total_rupees: 1178,
  address_json: JSON.stringify({ name: 'A', phone: '', line1: 'x', city: 'c', state: 's', pincode: '248001' }), contact_name: 'A',
  terms_accepted_at: 1, refund_policy_accepted_at: 1, refund_policy_version: 'shop-refunds-2026-10-01',
  pay_status: 'awaiting_payment', receiving_account_key: 'acct', amount_paise: 117_750, rounding_discount_paise: 50,
  payer_reference: null, reference_revision: 0, reason_code: null, utr: null, payer_vpa: null, matched_message_hash: null, confirm_source: null,
  paid_claimed_at: null, reviewed_by: null, review_note: null, reviewed_at: null, review_alerted_at: null, receipt_no: null, confirmed_at: null,
  expires_at: 1_000_000 + 30 * MIN, email_sent_at: null, fulfil_status: 'new', printrove_order_ref: null, courier: null, awb: null, tracking_url: null,
  eta_text: null, sent_to_printer_at: null, shipped_at: null, delivered_at: null, cancel_reason: null, refund_utr: null, refunded_at: null,
  problem_json: null, created_at: 1_000_000, updated_at: 1_000_000, ...over,
});
const ctx = (over: Record<string, unknown> = {}) => ({ now: 1_000_000 + MIN, canPay: true, vpa: 'shop@bank', payeeName: 'Test Payee', merchant: {}, note: 'shop order', reportWindowHours: 48, ...over });

describe('ids', () => {
  it('order id is shp_ + 20 hex and the order number is SHP- + 8 upper hex of it', () => {
    const id = newShopOrderId();
    expect(id).toMatch(SHOP_ORDER_ID_RE);
    expect(shopOrderNo('shp_0123456789abcdef0123')).toBe('SHP-01234567');
    expect(new Set(Array.from({ length: 50 }, newShopOrderId)).size).toBe(50);
  });
  it('receipt number is SS-<year>-<10 upper hex>', () => {
    expect(shopReceiptNo('shp_0123456789abcdef0123', Date.UTC(2026, 9, 1))).toBe('SS-2026-0123456789');
  });
  it('rejects ids that are not shop ids', () => {
    for (const bad of ['', 'shp_xyz', 'SHP-01234567', '0123456789abcdef0123', 'shp_0123456789abcdef01234']) expect(SHOP_ORDER_ID_RE.test(bad)).toBe(false);
  });
});

describe('external status (event rules reused)', () => {
  it('awaiting -> expired on the clock, cancelled -> expired, 180 s after "I\'ve paid" -> review_pending/awaiting_bank', () => {
    expect(shopExternalStatus(base(), 1_000_000 + MIN)).toBe('awaiting_payment');
    expect(shopExternalStatus(base(), 1_000_000 + 31 * MIN)).toBe('expired');
    expect(shopExternalStatus(base({ pay_status: 'cancelled', reason_code: 'rejected' }))).toBe('expired');
    const claimed = base({ paid_claimed_at: 1_000_000 });
    expect(shopExternalStatus(claimed, 1_000_000 + 170_000)).toBe('awaiting_payment');
    expect(shopExternalStatus(claimed, 1_000_000 + 181_000)).toBe('review_pending');
    expect(shopExternalReason(claimed, 1_000_000 + 181_000)).toBe('awaiting_bank');
    expect(shopExternalStatus(base({ pay_status: 'confirmed' }), 9e12)).toBe('confirmed');
  });
  it('open for matching mirrors the event predicate', () => {
    expect(shopOpenForMatching(base())).toBe(true);
    expect(shopOpenForMatching(base({ pay_status: 'review_pending' }))).toBe(true);
    expect(shopOpenForMatching(base({ pay_status: 'confirmed' }))).toBe(false);
    expect(shopOpenForMatching(base({ confirmed_at: 5 }))).toBe(false);
    expect(shopOpenForMatching(base({ reason_code: 'finalize_error' }))).toBe(false);
  });
});

describe('tracker steps', () => {
  it('Ordered -> Paid -> Printing -> Shipped -> Delivered, with terminal cancelled/refunded', () => {
    expect(shopStep('awaiting_payment', 'new')).toBe('ordered');
    expect(shopStep('review_pending', 'new')).toBe('ordered');
    expect(shopStep('expired', 'new')).toBe('ordered');
    const m: Record<ShopFulfilStatus, string> = { new: 'paid', at_printer: 'printing', shipped: 'shipped', delivered: 'delivered', cancelled: 'cancelled', refunded: 'refunded' };
    for (const [fulfil, step] of Object.entries(m)) expect(shopStep('confirmed', fulfil as ShopFulfilStatus)).toBe(step);
  });
});

describe('admin transitions', () => {
  const states: ShopFulfilStatus[] = ['new', 'at_printer', 'shipped', 'delivered', 'cancelled', 'refunded'];
  const allowed: Record<ShopAction, ShopFulfilStatus[]> = {
    'at-printer': ['new'], shipped: ['new', 'at_printer'], delivered: ['shipped'], cancel: ['new', 'at_printer'],
    refund: ['new', 'at_printer', 'shipped', 'delivered', 'cancelled'],
  };
  for (const action of Object.keys(allowed) as ShopAction[]) {
    it(`${action} is legal from exactly ${allowed[action].join(', ')}`, () => {
      for (const s of states) expect(canTransition(action, s)).toBe(allowed[action].includes(s));
    });
  }
  it('a refunded order accepts nothing; targets are right', () => {
    for (const a of Object.keys(allowed) as ShopAction[]) expect(canTransition(a, 'refunded')).toBe(false);
    expect(SHOP_TRANSITIONS['at-printer'].to).toBe('at_printer');
    expect(SHOP_TRANSITIONS.refund.to).toBe('refunded');
  });
});

describe('receipt money', () => {
  it('splits the unique-amount rounding discount like events; subtotal + GST = collected total; coupon + free shipping lines', () => {
    const r = shopReceiptMoney(base({ discount_rupees: 100, coupon_code: 'DIWALI', subtotal_rupees: 998, gst_rupees: 162, total_rupees: 1060, amount_paise: 105_950 }));
    expect(r.lines.map((l) => l.label)).toEqual(['Om Tee (Black, M)', 'Coupon DIWALI', 'Shipping (free)', 'UPI rounding discount']);
    expect(r.lines.find((l) => l.label === 'Coupon DIWALI')!.amount_rupees).toBe(-100);
    expect(r.totalRupees).toBe(1059.5);
    expect(Math.round((r.subtotalRupees + r.gstRupees) * 100)).toBe(105_950);
    expect(r.gstRatePct).toBe(18);
  });
  it('no discount, no rounding: identical to the order totals', () => {
    const r = shopReceiptMoney(base({ amount_paise: 117_800 }));
    expect(r.subtotalRupees).toBe(998);
    expect(r.gstRupees).toBe(180);
    expect(r.totalRupees).toBe(1178);
    expect(r.lines.map((l) => l.label)).toEqual(['Om Tee (Black, M)', 'Shipping (free)']);
  });
});

describe('UPI link + envelope', () => {
  it('builds a upi:// link with the exact amount and the shop note', () => {
    const u = new URL(shopUpiUri({ vpa: 'shop@bank', payeeName: 'Test Payee', amountPaise: 117_750, note: 'shop order', merchant: { mc: '5699' } }));
    expect(u.protocol).toBe('upi:');
    expect(u.searchParams.get('pa')).toBe('shop@bank');
    expect(u.searchParams.get('am')).toBe('1177.50');
    expect(u.searchParams.get('cu')).toBe('INR');
    expect(u.searchParams.get('tn')).toBe('shop order');
    expect(u.searchParams.get('mc')).toBe('5699');
  });
  it('envelope has exactly the spec §4.2 shape', () => {
    const o = buildShopOrder(base(), ctx(), [{ kind: 'created', at: 1 }]);
    expect(Object.keys(o).sort()).toEqual([
      'address', 'can_report_problem', 'confirmed_at', 'created_at', 'fulfil_status', 'items', 'order_id', 'order_no',
      'paid_claimed_at', 'pay_amount_paise', 'payment', 'quote', 'reason_code', 'receipt_url', 'rounding_discount_paise', 'shipment', 'status', 'step', 'timeline', 'upi',
    ]);
    expect(Object.keys(o.payment).sort()).toEqual(['amount_paise', 'amount_rupees', 'expires_at', 'payee_name', 'reason_code', 'reference_revision', 'upi_url', 'utr', 'vpa']);
    expect(o.payment.amount_rupees).toBe(1177.5);
    expect(o.upi.uri).toBe(o.payment.upi_url);
    expect(o.upi.uri).toContain('am=1177.50');
    expect(o.timeline).toEqual([{ kind: 'created', at: 1 }]);
    expect(o.quote.taxable_rupees).toBe(998);
    expect(o.quote.shipping_rupees).toBe(0);
    expect(o.receipt_url).toBeNull();
    expect(o.shipment).toBeNull();
  });
  it('no payment link once expired or when the rail is off; receipt + shipment after confirm/ship', () => {
    expect(buildShopOrder(base(), ctx({ now: 1_000_000 + 40 * MIN })).upi.uri).toBeNull();
    expect(buildShopOrder(base(), ctx({ canPay: false })).upi.uri).toBeNull();
    const o = buildShopOrder(base({ pay_status: 'confirmed', receipt_no: 'SS-2026-0123456789', fulfil_status: 'shipped', courier: 'Delhivery', awb: 'D1', tracking_url: 'https://t/D1', shipped_at: 5 }), ctx());
    expect(o.status).toBe('confirmed');
    expect(o.step).toBe('shipped');
    expect(o.receipt_url).toBe('/api/shop/orders/shp_0123456789abcdef0123/receipt.pdf');
    expect(o.shipment).toEqual({ courier: 'Delhivery', awb: 'D1', tracking_url: 'https://t/D1', eta_text: null, shipped_at: 5, delivered_at: null });
  });
  it('can_report_problem: delivered, inside the window, not yet reported', () => {
    const delivered = base({ pay_status: 'confirmed', fulfil_status: 'delivered', delivered_at: 1_000_000 });
    expect(buildShopOrder(delivered, ctx({ now: 1_000_000 + 47 * 3_600_000 })).can_report_problem).toBe(true);
    expect(buildShopOrder(delivered, ctx({ now: 1_000_000 + 49 * 3_600_000 })).can_report_problem).toBe(false);
    expect(buildShopOrder({ ...delivered, problem_json: '{"message":"x"}' }, ctx()).can_report_problem).toBe(false);
    expect(buildShopOrder(base({ pay_status: 'confirmed', fulfil_status: 'shipped' }), ctx()).can_report_problem).toBe(false);
    expect(reportWindowOpen({ fulfil_status: 'delivered', delivered_at: 0 }, 48, 48 * 3_600_000)).toBe(true);
    expect(reportWindowOpen({ fulfil_status: 'delivered', delivered_at: 0 }, 48, 48 * 3_600_000 + 1)).toBe(false);
  });
});

describe('helpers', () => {
  it('IST day start', () => {
    // 2026-10-01 20:00 UTC is 2026-10-02 01:30 IST -> day start 2026-10-01 18:30 UTC
    expect(istDayStartMs(Date.UTC(2026, 9, 1, 20, 0))).toBe(Date.UTC(2026, 9, 1, 18, 30));
  });
  it('validHttpUrl only accepts http(s)', () => {
    expect(validHttpUrl('https://x.example/a?b=1')).toBe('https://x.example/a?b=1');
    for (const bad of ['javascript:alert(1)', 'ftp://x', 'nope', '', null, 5]) expect(validHttpUrl(bad)).toBeNull();
  });
  it('utr last 4', () => { expect(utrLast4('123456789012')).toBe('9012'); expect(utrLast4(null)).toBeNull(); });
  it('every tab has SQL', () => { for (const t of SHOP_TABS) expect(SHOP_TAB_SQL[t].length).toBeGreaterThan(5); });
});
