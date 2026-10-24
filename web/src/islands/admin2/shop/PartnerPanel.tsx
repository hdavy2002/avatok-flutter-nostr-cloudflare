/* PartnerPanel — [AUMFE-POD-FULFIL-1 2026-10-01] /admin/shop/partner — replica of Specs/studio-mockup/PrintPartner.dc.html.
 * Talks to the partner API of AUMFE-POD-CORE-1 (spec §3): GET partner, POST partner/test, POST partner/sync, PUT partner/settings.
 * [HF-MERCH-PT-LOGIN-1] The login fields are now editable (PUT/DELETE partner/login, stored in KV on the server).
 * Deviations from the mockup (and the two message toggles are fixed on): the Printrove
 * login fields are read-only ("kept on the server as secrets"), and "Message the buyer" / "Alert me on problems" show as always on. */
import { useCallback, useEffect, useState } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { toast } from '../../../components/ui/sonner';
import { LoadError, Spinner } from './ShopUI';
import { DesiCard, DesiChip, DesiJourney, Marigold } from '../desi';
import { dmyYearTime, errMessage, getPartner, putPartnerSettings, removePartnerLogin, savePartnerLogin, syncPartner, testPartner, type PartnerState } from './shopApi';
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginMsg, setLoginMsg] = useState<{ ok: boolean; message: string } | null>(null);
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

  /* [HF-MERCH-PT-LOGIN-1] The password is sent once, never kept in state after saving, never sent to analytics. */
  async function saveLogin() {
    setBusy('login'); setLoginMsg(null);
    try {
      const r = await savePartnerLogin({ email: email.trim(), password });
      capture('admin2_pod_partner_login_saved', { connected: r.connected });
      setPassword(''); setEmail(''); setTestMsg(null);
      setLoginMsg({ ok: r.connected, message: r.message });
      (r.connected ? toast.success : toast.error)(r.message);
      await load();
    } catch (e) {
      captureException(e, { where: 'admin2_pod_partner_login_save' });
      const m = errMessage(e, 'The login did not save. Please try again.');
      setLoginMsg({ ok: false, message: m });
      toast.error(m);
    } finally { setBusy(''); }
  }

  async function removeLogin() {
    if (!window.confirm('Remove the saved Printrove login? Products cannot be approved and orders cannot be sent until you add it again.')) return;
    setBusy('login_remove');
    try {
      const r = await removePartnerLogin();
      capture('admin2_pod_partner_login_removed');
      setTestMsg(null); setLoginMsg(null);
      toast.success(r.message);
      await load();
    } catch (e) {
      captureException(e, { where: 'admin2_pod_partner_login_remove' });
      toast.error(errMessage(e, 'Could not remove the login.'));
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
  const stamp = !printrove?.configured ? { cls: 'bad', label: 'Not connected' }
    : conn?.ok ? { cls: 'ok', label: 'Connected' }
      : conn ? { cls: 'bad', label: 'Not working' } : { cls: 'warn', label: 'Not tested yet' };

  const toggle = (on: boolean, label: string, disabled: boolean, onClick?: () => void, title?: string) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`pw-tog${on ? ' is-on' : ''}`} disabled={disabled} title={title} onClick={onClick} />
  );

  return (
    <div className="shop-admin">
      <div className="hfa-stack pw-page">
        <section className="pw-shop">
          <div className="pw-toran" aria-hidden="true">
            {Array.from({ length: 11 }, (_, i) => (
              <span key={i} className="pw-hang" style={{ ['--h' as string]: `${14 + ((i * 7) % 5) * 9}px` }}><i /><Marigold size={38} tone={i % 3 === 1 ? 1 : 0} /></span>
            ))}
          </div>
          <div className="pw-sign">
            <b>Your printing partner</b>
            <span>Every paid order is printed, packed and shipped for you. You only watch it travel.</span>
          </div>
        </section>

        <DesiCard tone="cream" corner="jasmine" title="The journey of every order" note="Set what happens at each stop.">
          <DesiJourney label="Order journey" steps={[
            { title: 'Paid', tone: 'rani', note: <span className="pw-ctl">Money received</span> },
            { title: 'Sent to printer', tone: 'lav', note: (
              <span className="pw-ctl">
                <span>Send paid orders automatically</span>
                <span className="pw-small">Off: you press "Send to Printrove" on each paid order.</span>
                {toggle(p.auto_send, 'Send paid orders automatically', !!busy || !usingPrintrove, () => void save({ auto_send: !p.auto_send }, 'auto_send'), usingPrintrove ? undefined : 'Switch to Printrove first')}
              </span>) },
            { title: 'Printing', tone: 'gold', note: (
              <span className="pw-ctl">
                <span>Check order status</span>
                <span className="pw-small">Printrove has no update push, so we ask every {p.poll_minutes} minutes.</span>
                <select className="pw-fld pw-sel" value={p.poll_minutes} disabled={!!busy} aria-label="How often to check status"
                  onChange={(e) => void save({ poll_minutes: Number(e.target.value) }, 'poll_minutes')}>
                  {[...new Set([15, 30, 60, 120, p.poll_minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} min</option>)}
                </select>
              </span>) },
            { title: 'Shipped', tone: 'tea', note: (
              <span className="pw-ctl">
                <span>Message the buyer</span>
                <span className="pw-small">WhatsApp + email on printing, shipped and delivered.</span>
                {toggle(p.notify_buyer, 'Message the buyer (always on)', true, undefined, 'Always on')}
              </span>) },
            { title: 'Delivered', tone: 'plum', note: (
              <span className="pw-ctl">
                <span>Alert me on problems</span>
                <span className="pw-small">WhatsApp to the owner number when an order is stuck.</span>
                {toggle(p.alert_owner, 'Alert me on problems (always on)', true, undefined, 'Always on')}
              </span>) },
          ]} />
        </DesiCard>

        <div className="hfa-row pw-partners">
          <section className="hfa-card hfa-t-rani pw-printrove">
            <span className={`pw-stamp ${stamp.cls}`}>{stamp.label}</span>
            <h3 className="pw-h">{printrove?.label ?? 'Printrove'}</h3>
            {usingPrintrove && <DesiChip tone="plum">Current partner</DesiChip>}
            <p>{!printrove?.configured ? 'Add your Printrove login in the "Printrove account" box below.'
              : conn && !conn.ok ? conn.message
                : expires ? `Login token valid till ${dmyYearTime(expires)}.` : 'Press Test connection to check the login.'}</p>
            <div className="pw-row">
              <button type="button" className="hfa-btn ghost" disabled={busy === 'test' || !printrove?.configured} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
              {!usingPrintrove && <button type="button" className="hfa-btn rani" disabled={!!busy || !printrove?.configured} onClick={() => void save({ provider: 'printrove' }, 'provider')}>Use this</button>}
            </div>
          </section>
          <DesiCard tone="gold" corner="marigold" className="pw-hand">
            <h3 className="pw-h">By hand</h3>
            <DesiChip tone={!usingPrintrove ? 'plum' : 'gold'}>{!usingPrintrove ? 'In use' : 'Backup'}</DesiChip>
            <p>You place orders in the partner's dashboard and type in the AWB, like today.</p>
            <div className="pw-row">{usingPrintrove && <button type="button" className="hfa-btn gold" disabled={!!busy} onClick={() => void save({ provider: 'manual' }, 'provider')}>Use this</button>}</div>
          </DesiCard>
          <section className="pw-add">
            <span className="pw-plus" aria-hidden="true">+</span>
            <h3 className="pw-h">Add another partner</h3>
            <p>A new partner needs its connector built once. Then use "Move all products" below.</p>
          </section>
        </div>

        <div className="hfa-row pw-trio">
          <DesiCard pattern="bahi" title="Printrove account">
            {p.login?.configured && (
              <p className="pw-small" role="status">
                <DesiChip tone="tea">Saved</DesiChip> Logged in as <b>{p.login.email_masked}</b>
                {p.login.stored_in === 'secret' ? ' (set on the server).' : '.'} The password is never shown.
              </p>
            )}
            <form onSubmit={(e) => { e.preventDefault(); if (email.trim() && password) void saveLogin(); }} autoComplete="off">
              <label className="pw-lbl">Login email
                <input className="pw-fld pw-line" type="email" name="printrove-login-email" autoComplete="off" value={email} disabled={!!busy}
                  placeholder={p.login?.configured ? 'Type a new email to change it' : 'The email you use on Printrove'} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="pw-lbl">Password
                <input className="pw-fld pw-line" type="password" name="printrove-login-secret" autoComplete="new-password" value={password} disabled={!!busy}
                  placeholder={p.login?.configured ? 'Type a new password to change it' : 'Your Printrove password'} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <div className="pw-row">
                <button type="submit" className="hfa-btn rani" disabled={!!busy || !email.trim() || !password}>{busy === 'login' ? 'Saving…' : 'Save login'}</button>
                {p.login?.configured && p.login.stored_in === 'kv' && (
                  <button type="button" className="hfa-btn ghost" disabled={!!busy} onClick={() => void removeLogin()}>{busy === 'login_remove' ? 'Removing…' : 'Remove login'}</button>
                )}
              </div>
            </form>
            {loginMsg && <p className="pw-small" role="status" style={{ color: loginMsg.ok ? undefined : '#b3261e' }}>{loginMsg.message}</p>}
            <p className="pw-small">Kept only on the server. Never shown on the website.</p>
          </DesiCard>
          <DesiCard tone="lav" corner="jasmine" title="Catalogue" note="Products, colours, sizes and costs the partner offers. Studio only shows these.">
            <div className="pw-count"><span>{p.catalog.count}</span>products</div>
            <div className="pw-row">
              <DesiChip tone="lav">Last synced {ago(p.catalog.synced_at)}</DesiChip>
              <button type="button" className="hfa-btn" disabled={busy === 'sync'} onClick={() => void sync()}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
            </div>
          </DesiCard>
          <DesiCard pattern="stripes" title="Move all products to a new partner" note="Re-sends every locked print file and placement to the new partner and re-links sizes and colours. Old orders stay with Printrove.">
            <button type="button" className="hfa-btn ghost" disabled aria-disabled="true">Move all products</button>
          </DesiCard>
        </div>
      </div>
    </div>
  );
}
