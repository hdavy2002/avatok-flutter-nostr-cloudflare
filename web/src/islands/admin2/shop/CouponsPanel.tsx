/* CouponsPanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop/coupons — the mockup's coupon table
 * (Code / Discount / Min order / Used / Valid till / Status) plus add + edit (spec §5.5).
 * API (spec §4.4): GET coupons, POST coupons, PUT coupons/:code. */
import { useCallback, useEffect, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { LoadError, Modal, Spinner } from './ShopUI';
import { createCoupon, digitsOnly, dmy, errMessage, inr, listCoupons, updateCoupon, type Coupon } from './shopApi';

const endOfDayIst = (ymd: string): number => new Date(`${ymd}T23:59:59+05:30`).getTime();
const ymdIst = (ms: number | null): string => (ms ? new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10) : '');

export default function CouponsPanel() {
  const [items, setItems] = useState<Coupon[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Coupon | 'new' | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setItems((await listCoupons()).items); }
    catch (e) { captureException(e, { where: 'admin2_shop_coupons_load' }); setError(errMessage(e, 'Could not load the coupons.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!items) return <div className="sh-apanel is-on"><Spinner /></div>;
  const now = Date.now();

  return (
    <div className="sh-apanel is-on" data-apanel="coupons">
      <div style={{ marginBottom: 14 }}><button type="button" className="sh-btn sh-btn--teal" onClick={() => setEdit('new')}>+ Add coupon</button></div>
      <div className="sh-tbl-wrap">
        <table className="sh-table">
          <thead><tr><th>Code</th><th>Discount</th><th>Min order</th><th>Used</th><th>Valid till</th><th>Status</th><th /></tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 30 }}>No coupons yet.</td></tr>}
            {items.map((c) => {
              const expired = !!c.valid_until && c.valid_until < now;
              const spent = c.max_uses != null && c.used_count >= c.max_uses;
              const chip = !c.active ? { cls: 'st-pending', label: 'Paused' } : expired || spent ? { cls: 'st-cancelled', label: 'Expired' } : { cls: 'st-delivered', label: 'Active' };
              return (
                <tr key={c.code}>
                  <td><b>{c.code}</b></td>
                  <td>{c.kind === 'pct' ? `${c.value}% off` : `${inr(c.value)} off`}</td>
                  <td>{c.min_order_rupees ? inr(c.min_order_rupees) : '—'}</td>
                  <td>{c.used_count} / {c.max_uses ?? '∞'}</td>
                  <td>{c.valid_until ? dmy(c.valid_until) : '—'}</td>
                  <td><span className={`sh-st ${chip.cls}`}>{chip.label}</span></td>
                  <td><button type="button" className="sh-btn sh-btn--ghost sh-mini" onClick={() => setEdit(c)}>Edit</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <CouponModal c={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />
    </div>
  );
}

function CouponModal({ c, onClose, onSaved }: { c: Coupon | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const editing = c !== null && c !== 'new' ? c : null;
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'pct' | 'flat'>('pct');
  const [value, setValue] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [till, setTill] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    setErr('');
    setCode(editing?.code ?? ''); setKind(editing?.kind ?? 'pct'); setValue(editing ? String(editing.value) : '');
    setMin(editing?.min_order_rupees ? String(editing.min_order_rupees) : ''); setMax(editing?.max_uses != null ? String(editing.max_uses) : '');
    setTill(ymdIst(editing?.valid_until ?? null)); setActive(editing ? !!editing.active : true);
  }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    const v = Number(value);
    const cc = code.trim().toUpperCase();
    if (!editing && !/^[A-Z0-9_-]{3,24}$/.test(cc)) return setErr('Code: 3–24 letters or numbers, e.g. NAVRATRI10.');
    if (!Number.isInteger(v) || v < 1) return setErr('Enter the discount value.');
    if (kind === 'pct' && v > 90) return setErr('A percentage coupon can be at most 90%.');
    setBusy(true);
    try {
      const body = {
        ...(editing ? {} : { code: cc }), kind, value: v, min_order_rupees: min ? Number(min) : 0,
        max_uses: max ? Number(max) : null, valid_until: till ? endOfDayIst(till) : null, active,
      };
      if (editing) await updateCoupon(editing.code, body); else await createCoupon(body);
      capture('admin2_shop_coupon_saved', { code: editing?.code ?? cc, created: !editing });
      toast.success(editing ? 'Coupon saved' : 'Coupon added');
      onSaved();
    } catch (er) { captureException(er, { where: 'admin2_shop_coupon_save' }); setErr(errMessage(er, 'Could not save the coupon.')); }
    finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{editing ? `Edit ${editing.code}` : 'Add coupon'}</h2>
        <p>Applies to the cart total before GST. One code per order.</p>
        <div className="sh-form">
          <label className="full">Code<input value={code} disabled={!!editing} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="NAVRATRI10" style={{ textTransform: 'uppercase' }} /></label>
          <label>Type<select value={kind} onChange={(e) => setKind(e.target.value as 'pct' | 'flat')}><option value="pct">Percent off</option><option value="flat">Flat ₹ off</option></select></label>
          <label>{kind === 'pct' ? 'Percent' : 'Rupees off'}<input inputMode="numeric" value={value} onChange={(e) => setValue(digitsOnly(e.target.value, 5))} /></label>
          <label>Min order (₹)<input inputMode="numeric" value={min} onChange={(e) => setMin(digitsOnly(e.target.value, 6))} placeholder="none" /></label>
          <label>Max uses<input inputMode="numeric" value={max} onChange={(e) => setMax(digitsOnly(e.target.value, 6))} placeholder="unlimited" /></label>
          <label className="full">Valid till<input type="date" value={till} onChange={(e) => setTill(e.target.value)} /></label>
        </div>
        <label className="sh-opt" style={{ marginTop: 14 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>
        {err && <p className="sh-err" role="alert">{err}</p>}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" className="sh-btn sh-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="sh-btn sh-btn--teal" style={{ flex: 1 }} disabled={busy}>{busy ? 'Saving…' : 'Save coupon'}</button>
        </div>
      </form>
    </Modal>
  );
}
