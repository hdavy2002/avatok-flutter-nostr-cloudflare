/* PartnerPanel — [AUMFE-POD-FULFIL-1 2026-10-01] /admin/shop/partner — replica of Specs/studio-mockup/PrintPartner.dc.html.
 * Talks to the partner API of AUMFE-POD-CORE-1 (spec §3): GET partner, POST partner/test, POST partner/sync, PUT partner/settings.
 * Deviations from the mockup (the API has no way to store a password, and the two message toggles are fixed on): the Printrove
 * login fields are read-only ("kept on the server as secrets"), and "Message the buyer" / "Alert me on problems" show as always on. */
import { useCallback, useEffect, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { LoadError, Spinner } from './ShopUI';
import { dmyTime, errMessage, getPartner, putPartnerSettings, syncPartner, testPartner, type PartnerState } from './shopApi';
import './shopAdmin.css';
import './ordersPod.css';
import './partnerPanel.css';

const ago = (ms: number | null | undefined): string => {
  if (!ms) return 'never';
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
};

export default function PartnerPanel() {
  const [p, setP] = useState<PartnerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string; token_expires_at?: number } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setP(await getPartner()); }
    catch (e) { captureException(e, { where: 'admin2_pod_partner_load' }); setError(errMessage(e, 'Could not load the print partner settings.')); }
  }, []);
  useEffect(() => { capture('admin2_pod_partner_viewed'); void load(); }, [load]);

  async function save(body: Parameters<typeof putPartnerSettings>[0], event: string): Promise<void> {
    setBusy(event);
    try {
      await putPartnerSettings(body);
      capture(`admin2_pod_partner_${event}`, body as Record<string, unknown>);
      toast.success('Saved');
      await load();
    } catch (e) {
      captureException(e, { where: `admin2_pod_partner_${event}` });
      toast.error(errMessage(e, 'That did not save. Please try again.'));
    } finally { setBusy(''); }
  }

  async function test() {
    setBusy('test');
    try {
      const r = await testPartner();
      setTestMsg(r);
      capture('admin2_pod_partner_test', { ok: r.ok });
      (r.ok ? toast.success : toast.error)(r.message);
      await load();
    } catch (e) {
      captureException(e, { where: 'admin2_pod_partner_test' });
      toast.error(errMessage(e, 'Could not reach the print partner.'));
    } finally { setBusy(''); }
  }

  async function sync() {
    setBusy('sync');
    try {
      const r = await syncPartner();
      capture('admin2_pod_partner_sync', { count: r.count });
      toast.success(`Catalogue synced · ${r.count} products`);
      await load();
    } catch (e) {
      captureException(e, { where: 'admin2_pod_partner_sync' });
      toast.error(errMessage(e, 'The catalogue did not sync.'));
    } finally { setBusy(''); }
  }

  if (error) return <div className="shop-admin"><LoadError message={error} onRetry={() => void load()} /></div>;
  if (!p) return <div className="shop-admin"><Spinner /></div>;

  const printrove = p.providers.find((x) => x.id === 'printrove');
  const conn = testMsg ?? p.connection;
  const usingPrintrove = p.provider === 'printrove';
  const expires = conn?.token_expires_at;

  return (
    <div className="shop-admin">
      <div className="pp-g2" style={{ alignItems: 'start' }}>
        <div>
          <div className="pp-panel"><h2>Current partner</h2>
            <div className="pp-g2">
              <div className={`pp-card${usingPrintrove ? ' is-sel' : ''}`}>
                <h3>{printrove?.label ?? 'Printrove'}</h3>
                {!printrove?.configured
                  ? <span className="sh-chip sh-chip--bad">Not connected</span>
                  : conn?.ok ? <span className="sh-chip sh-chip--ok">Connected ✓</span>
                    : conn ? <span className="sh-chip sh-chip--bad">Not working</span> : <span className="sh-chip sh-chip--warn">Not tested yet</span>}
                <p>{!printrove?.configured ? 'The login has not been added to the server yet.'
                  : conn && !conn.ok ? conn.message
                    : expires ? `Login token valid till ${dmyTime(expires)}.` : 'Press Test connection to check the login.'}</p>
                <div className="pp-row">
                  <button type="button" className="sh-btn sh-btn--ghost sh-mini" disabled={busy === 'test' || !printrove?.configured} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
                  {!usingPrintrove && <button type="button" className="sh-btn sh-btn--ghost sh-mini" disabled={!!busy || !printrove?.configured} onClick={() => void save({ provider: 'printrove' }, 'provider')}>Use this</button>}
                </div>
              </div>
              <div className={`pp-card${!usingPrintrove ? ' is-sel' : ''}`}>
                <h3>By hand</h3>
                <span className={`sh-chip${!usingPrintrove ? ' sh-chip--ok' : ''}`}>{!usingPrintrove ? 'In use' : 'Backup'}</span>
                <p>You place orders in the partner's dashboard and type in the AWB, like today.</p>
                <div className="pp-row">{usingPrintrove && <button type="button" className="sh-btn sh-btn--ghost sh-mini" disabled={!!busy} onClick={() => void save({ provider: 'manual' }, 'provider')}>Use this</button>}</div>
              </div>
            </div>
            <div className="pp-card is-dash" style={{ marginTop: 14 }}><h3>Add another partner</h3><p>A new partner needs its connector built once. Then use "Move all products" below.</p></div>
          </div>
          <div className="pp-panel"><h2>Printrove account</h2>
            <label className="pp-lbl">Login email<input className="pp-fld" disabled placeholder={printrove?.configured ? 'Saved on the server' : 'Not added yet'} /></label>
            <label className="pp-lbl" style={{ marginTop: 12 }}>Password<input className="pp-fld" type="password" disabled placeholder={printrove?.configured ? '••••••••••' : 'Not added yet'} /></label>
            <p className="pp-small">Kept only on the server as secrets (PRINTROVE_EMAIL, PRINTROVE_PASSWORD). Never shown on the website.</p>
          </div>
        </div>
        <div>
          <div className="pp-panel"><h2>Automation</h2>
            <ul className="pp-list">
              <li>
                <div style={{ flex: 1 }}><b>Send paid orders automatically</b><br />Off: you press "Send to Printrove" on each paid order. Turn on after the first orders go well.</div>
                <button type="button" role="switch" aria-checked={p.auto_send} aria-label="Send paid orders automatically" className={`pp-tog${p.auto_send ? ' is-on' : ''}`} disabled={!!busy || !usingPrintrove}
                  title={usingPrintrove ? undefined : 'Switch to Printrove first'} onClick={() => void save({ auto_send: !p.auto_send }, 'auto_send')} />
              </li>
              <li>
                <div style={{ flex: 1 }}><b>Check order status</b><br />Printrove has no update push, so we ask every {p.poll_minutes} minutes.</div>
                <select className="pp-fld" style={{ width: 140 }} value={p.poll_minutes} disabled={!!busy} aria-label="How often to check status"
                  onChange={(e) => void save({ poll_minutes: Number(e.target.value) }, 'poll_minutes')}>
                  {[...new Set([15, 30, 60, 120, p.poll_minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} min</option>)}
                </select>
              </li>
              <li>
                <div style={{ flex: 1 }}><b>Message the buyer</b><br />WhatsApp + email on printing, shipped and delivered.</div>
                <button type="button" role="switch" aria-checked={p.notify_buyer} aria-label="Message the buyer (always on)" className={`pp-tog${p.notify_buyer ? ' is-on' : ''}`} disabled title="Always on" />
              </li>
              <li>
                <div style={{ flex: 1 }}><b>Alert me on problems</b><br />WhatsApp to the owner number when an order is stuck.</div>
                <button type="button" role="switch" aria-checked={p.alert_owner} aria-label="Alert me on problems (always on)" className={`pp-tog${p.alert_owner ? ' is-on' : ''}`} disabled title="Always on" />
              </li>
            </ul>
          </div>
          <div className="pp-panel"><h2>Catalogue</h2><p className="pp-lead">Products, colours, sizes and costs the partner offers. Studio only shows these.</p>
            <div className="pp-row">
              <span className="sh-chip sh-chip--info">Last synced {ago(p.catalog.synced_at)}</span>
              <span className="sh-chip">{p.catalog.count} products</span>
              <button type="button" className="sh-btn sh-btn--ghost sh-mini" disabled={busy === 'sync'} onClick={() => void sync()}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
            </div>
          </div>
          <div className="pp-panel"><h2>Move all products to a new partner</h2><p className="pp-lead">Re-sends every locked print file and placement to the new partner and re-links sizes and colours. Old orders stay with Printrove.</p>
            <button type="button" className="sh-btn sh-btn--ghost" disabled aria-disabled="true" style={{ opacity: 0.55 }}>Move all products</button>
          </div>
        </div>
      </div>
    </div>
  );
}
