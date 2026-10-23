/* MerchSettings — [HF-MERCH-ADMIN-1] The ten merch settings in plain words, with a worked example that recalculates as you type.
 * Worker: GET|PUT /api/admin/merch/settings (one PUT writes all ten). The maths mirrors worker/src/lib/hf_merch_math.ts (integer paise). */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banner, adminCall, click, fail, money, usePageView, type MerchSettings as S } from './merchKit';

const KEYS = ['hfMerchEnabled', 'hfMerchCheckoutEnabled', 'hfMerchAutoApprove', 'hfMerchProductReview', 'hfMerchPlatformShareBps', 'hfMerchMinMarkupRupees', 'hfMerchBaseBufferRupees', 'hfMerchCashfreeFeeBps', 'hfMerchGstBps', 'hfMerchHoldDays'] as const;
const BOOLS: { k: keyof S; label: string; hint: string }[] = [
  { k: 'hfMerchEnabled', label: 'Merch shop is on', hint: 'Off hides every merch page and strip from fans and influencers.' },
  { k: 'hfMerchCheckoutEnabled', label: 'Fans can pay', hint: 'Off shows “Coming soon” on product pages.' },
  { k: 'hfMerchAutoApprove', label: 'Approve paid orders automatically', hint: 'Off means every paid order waits for you on the Orders page.' },
  { k: 'hfMerchProductReview', label: 'Review new designs first', hint: 'On means a new or edited design waits for you before it goes live.' },
];
const bpsOf = (a: number, bps: number) => Math.floor((2 * Math.max(0, a) * Math.max(0, bps) + 10000) / 20000);

export default function MerchSettings() {
  usePageView('settings');
  const [saved, setSaved] = useState<S | null>(null);
  const [form, setForm] = useState<S | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ex, setEx] = useState({ base: '500', markup: '200', cashfree: true });

  const adopt = useCallback((s: S) => {
    setSaved(s); setForm(s);
    setText({
      hfMerchPlatformShareBps: String(s.hfMerchPlatformShareBps / 100), hfMerchMinMarkupRupees: String(s.hfMerchMinMarkupRupees), hfMerchBaseBufferRupees: String(s.hfMerchBaseBufferRupees),
      hfMerchCashfreeFeeBps: String(s.hfMerchCashfreeFeeBps / 100), hfMerchGstBps: String(s.hfMerchGstBps / 100), hfMerchHoldDays: String(s.hfMerchHoldDays),
    });
  }, []);
  const load = useCallback(async () => {
    setError(null);
    try { adopt((await adminCall<{ settings: S }>('/api/admin/merch/settings')).settings); } catch (e) { setError(fail('merch_settings_load', e)); }
  }, [adopt]);
  useEffect(() => { void load(); }, [load]);

  // Text boxes -> numbers (percent boxes become basis points). null = not a valid number yet.
  const parsed = useMemo(() => {
    const num = (k: string, scale: number, lo: number, hi: number) => { const v = Number((text[k] ?? '').trim()); const n = Math.round(v * scale); return text[k]?.trim() !== '' && Number.isFinite(v) && n >= lo && n <= hi ? n : null; };
    return {
      hfMerchPlatformShareBps: num('hfMerchPlatformShareBps', 100, 0, 10000), hfMerchMinMarkupRupees: num('hfMerchMinMarkupRupees', 1, 1, 5000), hfMerchBaseBufferRupees: num('hfMerchBaseBufferRupees', 1, 0, 1000),
      hfMerchCashfreeFeeBps: num('hfMerchCashfreeFeeBps', 100, 0, 1000), hfMerchGstBps: num('hfMerchGstBps', 100, 0, 2800), hfMerchHoldDays: num('hfMerchHoldDays', 1, 0, 60),
    };
  }, [text]);
  const valid = Object.values(parsed).every((v) => v !== null);

  const calc = useMemo(() => {
    const share = parsed.hfMerchPlatformShareBps ?? 4000;
    const base = Math.max(0, Math.round(Number(ex.base) || 0)) * 100 + (parsed.hfMerchBaseBufferRupees ?? 0) * 100;
    const markup = Math.max(0, Math.round(Number(ex.markup) || 0)) * 100;
    const total = base + markup;
    const infl = Math.floor((markup * (10000 - share)) / 10000);
    const plat = markup - infl;
    const fee = ex.cashfree ? bpsOf(total, parsed.hfMerchCashfreeFeeBps ?? 350) : 0;
    const gst = bpsOf(plat, parsed.hfMerchGstBps ?? 1800);
    return { base, markup, total, infl, plat, fee, gst, net: plat - fee - gst };
  }, [parsed, ex]);

  const dirty = !!saved && !!form && (BOOLS.some((b) => form[b.k] !== saved[b.k]) || KEYS.filter((k) => typeof saved[k] === 'number').some((k) => (parsed as Record<string, number | null>)[k] !== saved[k]));

  const save = async () => {
    if (!form || !valid) return;
    click('merch_settings_save_clicked', { auto_approve: form.hfMerchAutoApprove, enabled: form.hfMerchEnabled, checkout: form.hfMerchCheckoutEnabled });
    setBusy(true); setError(null); setInfo(null);
    const body: Record<string, boolean | number> = {};
    for (const b of BOOLS) body[b.k] = form[b.k] as boolean;
    for (const [k, v] of Object.entries(parsed)) body[k] = v as number;
    try { adopt((await adminCall<{ settings: S }>('/api/admin/merch/settings', { method: 'PUT', body })).settings); setInfo('Saved. New orders use these numbers; old orders keep the numbers they were bought with.'); }
    catch (e) { setError(fail('merch_settings_save', e)); }
    setBusy(false);
  };

  if (!form) return <div className="hfa-stack">{error ? <Banner tone="error">{error}</Banner> : <p className="mx-empty" role="status">Loading settings…</p>}</div>;
  const field = (k: keyof typeof parsed, label: string, unit: string, hint: string) => (
    <div className="mx-set">
      <div className="row"><label htmlFor={`mx-${k}`}>{label}</label>
        <span><input id={`mx-${k}`} className="mx-in" inputMode="decimal" value={text[k] ?? ''} aria-invalid={parsed[k] === null} onChange={(e) => setText({ ...text, [k]: e.target.value })} /> {unit}</span></div>
      <div className="hint">{hint}{parsed[k] === null ? ' — enter a valid number.' : ''}</div>
    </div>
  );
  return (
    <div className="hfa-stack">
      {error && <Banner tone="error">{error}</Banner>}
      {info && <Banner tone="info">{info}</Banner>}
      <div className="mx-cols">
        <section>
          <h2 className="mx-h">Switches</h2>
          {BOOLS.map((b) => (
            <div className="mx-set" key={b.k}>
              <div className="row"><label htmlFor={`mx-${b.k}`}>{b.label}</label>
                <button id={`mx-${b.k}`} type="button" role="switch" aria-checked={form[b.k] as boolean} className={`hfa-btn mx-toggle ${form[b.k] ? 'tea' : 'ghost'}`} onClick={() => setForm({ ...form, [b.k]: !form[b.k] })}>{form[b.k] ? 'On' : 'Off'}</button></div>
              <div className="hint">{b.hint}</div>
            </div>
          ))}
          <h2 className="mx-h" style={{ marginTop: 18 }}>Numbers</h2>
          {field('hfMerchPlatformShareBps', 'Platform share of markup', '%', 'The influencer keeps the rest of the markup.')}
          {field('hfMerchMinMarkupRupees', 'Smallest markup an influencer can set', '₹', 'Per shirt, whole rupees.')}
          {field('hfMerchBaseBufferRupees', 'Extra cushion on the printer’s cost', '₹', 'Added to every base price. Use it to cover small price changes.')}
          {field('hfMerchCashfreeFeeBps', 'Cashfree fee (estimate for reports)', '%', 'Report only. The platform absorbs it; the influencer is never charged.')}
          {field('hfMerchGstBps', 'GST on platform share (estimate for reports)', '%', 'Report only. The platform absorbs it.')}
          {field('hfMerchHoldDays', 'Days to hold earnings after delivery', 'days', 'The influencer can withdraw once this many days have passed.')}
          <div className="mx-acts" style={{ marginTop: 16 }}>
            <button type="button" className="hfa-btn tea" disabled={busy || !valid || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button>
            {dirty && <button type="button" className="hfa-btn ghost" disabled={busy} onClick={() => saved && adopt(saved)}>Undo changes</button>}
          </div>
        </section>
        <section>
          <h2 className="mx-h">Worked example</h2>
          <div className="mx-form">
            <label>Printer cost (base) ₹<input className="mx-in" inputMode="numeric" value={ex.base} onChange={(e) => setEx({ ...ex, base: e.target.value })} /></label>
            <label>Influencer markup ₹<input className="mx-in" inputMode="numeric" value={ex.markup} onChange={(e) => setEx({ ...ex, markup: e.target.value })} /></label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={ex.cashfree} onChange={(e) => setEx({ ...ex, cashfree: e.target.checked })} /> Fan pays through Cashfree</label>
          </div>
          <dl className="mx-kv" style={{ marginTop: 12 }}>
            <dt>Fan pays (incl. GST &amp; delivery)</dt><dd>{money(calc.total)}</dd>
            <dt>Printer is paid (base{parsed.hfMerchBaseBufferRupees ? ' + cushion' : ''})</dt><dd>{money(calc.base)}</dd>
            <dt>Influencer earns</dt><dd>{money(calc.infl)}</dd>
            <dt>Platform share</dt><dd>{money(calc.plat)}</dd>
            <dt>Cashfree fee</dt><dd>−{money(calc.fee)}</dd>
            <dt>GST</dt><dd>−{money(calc.gst)}</dd>
            <dt className="tot">Platform keeps</dt><dd className="tot">{money(calc.net)}</dd>
          </dl>
          <p className="hfa-note">With the default numbers, base ₹500 + markup ₹200 gives: fan ₹700, influencer ₹120, platform ₹80, Cashfree ₹24.50, GST ₹14.40, platform keeps ₹41.10.</p>
        </section>
      </div>
    </div>
  );
}
