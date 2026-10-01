/* SettingsPanel — [SAATHUM-SHOP-ADMIN-1 2026-10-01] /admin/shop/settings — the mockup's "Shop
 * settings" form. Shipping, international shipping, GST, returns and the print partner are the
 * owner's fixed rules (spec §0.3) and are shown read-only; delivery time, the report-a-problem
 * window and order alerts are editable and saved to shop_settings.policy.
 * API (spec §4.4): GET settings, PUT settings/policy {value}. */
import { useCallback, useEffect, useState } from 'react';
import { captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { LoadError, Spinner } from './ShopUI';
import { errMessage, getSettings, putSetting, type PolicySettings } from './shopApi';

export default function SettingsPanel() {
  const [policy, setPolicy] = useState<PolicySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState('');
  const [windowTxt, setWindowTxt] = useState('');
  const [alerts, setAlerts] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = (await getSettings()).policy ?? {};
      setPolicy(p);
      setDelivery(p.delivery_text ?? '5–8 days');
      setWindowTxt(`${p.report_window_hours ?? 48} hours from delivery`);
      setAlerts(p.alerts_whatsapp !== false);
    } catch (e) { captureException(e, { where: 'admin2_shop_settings_load' }); setError(errMessage(e, 'Could not load the settings.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!policy) return <div className="sh-apanel is-on"><Spinner /></div>;

  async function save() {
    const hours = Number(/\d+/.exec(windowTxt)?.[0] ?? '');
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) { toast.error('Report-a-problem window: enter the number of hours, e.g. 48.'); return; }
    if (delivery.trim().length < 2) { toast.error('Enter the delivery time to show, e.g. 5–8 days.'); return; }
    setBusy(true);
    try {
      const next: PolicySettings = { ...policy, delivery_text: delivery.trim(), report_window_hours: hours, print_partner: policy!.print_partner ?? 'Printrove', alerts_whatsapp: alerts };
      await putSetting('policy', next);
      setPolicy(next); setWindowTxt(`${hours} hours from delivery`);
      toast.success('Shop settings saved');
    } catch (e) { captureException(e, { where: 'admin2_shop_settings_save' }); toast.error(errMessage(e, 'Could not save the settings.')); }
    finally { setBusy(false); }
  }

  return (
    <div className="sh-apanel is-on" data-apanel="settings">
      <div className="sh-panel">
        <h2>Shop settings</h2>
        <p>Every number here feeds the shop pages and checkout — nothing is typed into pages.</p>
        <div className="sh-form">
          <label>Shipping<input value="Free, pan India (included in price)" readOnly disabled /></label>
          <label>International shipping<select disabled value="no"><option value="no">Not offered</option></select></label>
          <label>GST<input value="18% added at checkout" readOnly disabled /></label>
          <label>Returns<input value="Only if we sent the wrong item" readOnly disabled /></label>
          <label>Print partner<select disabled value="Printrove"><option>Printrove</option></select></label>
          <label>Report-a-problem window<input value={windowTxt} onChange={(e) => setWindowTxt(e.target.value)} onBlur={() => { const h = /\d+/.exec(windowTxt)?.[0]; if (h) setWindowTxt(`${Number(h)} hours from delivery`); }} /></label>
          <label>Delivery time shown<input value={delivery} onChange={(e) => setDelivery(e.target.value)} /></label>
          <label>Order alerts to
            <select value={alerts ? 'wa' : 'off'} onChange={(e) => setAlerts(e.target.value === 'wa')}><option value="wa">Owner WhatsApp</option><option value="off">Nobody</option></select>
          </label>
        </div>
        <div style={{ marginTop: 18 }}><button type="button" className="sh-btn sh-btn--red" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button></div>
      </div>
    </div>
  );
}
