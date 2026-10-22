/* UPI settings — [SAATHUM-UPI-SETTINGS 2026-09-27, owner request]
 * "In /admin create a sidebar menu called UPI settings, give me the option to
 * add my UPI address, then use it to generate the QR code and follow the
 * pipeline we built (12-digit UTR) to confirm payment."
 *   GET/PUT /api/admin/upi-settings  (worker/src/routes/upi_settings.ts)
 * Every checkout QR (routes/saathum_checkout.ts) reads the saved ID within
 * ~15 s — no deploy. Confirmation is unchanged: the HDFC credit SMS forwarded by
 * the SMS companion phone, matched with the buyer's 12-digit UTR. */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle2, AlertTriangle, Loader2, Save, Smartphone } from 'lucide-react';
import { ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { toast } from '../../components/ui/sonner';
import { istDateTime, errMessage } from './adminApi';
import { CopyValue, ErrorBox, ListSkeleton, adminCall } from './peopleKit';
import { DesiCard, DesiJourney, Marigold } from './desi';
import { BRAND } from '../../lib/brand';

type Status = {
  saved: { vpa: string | null; payee_name: string | null; updated_at: number | null; updated_by: string | null };
  active: { vpa: string | null; payee_name: string; source: 'admin' | 'env' | 'none' };
  rail: { enabled: boolean; reason: string | null };
  last_bank_sms_at: number | null;
};

const VPA_RE = /^[A-Za-z0-9._-]{2,200}@[A-Za-z0-9.-]{2,80}$/;
/** The bank-SMS companion is not on Google Play — it is a side-loaded APK
 * published as a GitHub release (public repo hdavy2002/upeo-sms-gateway). */
export const SMS_COMPANION_APK_URL =
  'https://github.com/hdavy2002/upeo-sms-gateway/releases/download/companion-prod-2026-09-17-r2/avatok-sms-companion-prod-release.apk';

const RAIL_REASON: Record<string, string> = {
  schema_not_ready: 'The payment database is not set up on this server.',
  configuration_incomplete: 'A UPI ID or the SMS phone’s device ID / secret / account digits are missing.',
  rail_paused: 'UPI payments are switched off (hdfcSmsEnabled flag).',
};

export default function UpiSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [vpa, setVpa] = useState('');
  const [payee, setPayee] = useState('');
  const [saving, setSaving] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  const apply = (s: Status) => {
    setStatus(s);
    setVpa(s.saved.vpa ?? s.active.vpa ?? '');
    setPayee(s.saved.payee_name ?? s.active.payee_name ?? '');
  };

  const load = async () => {
    setLoadError(null);
    try { apply(await adminCall<Status>('/api/admin/upi-settings')); }
    catch (e) { captureException(e, { where: 'admin2_upi_settings_load' }); setLoadError('Could not load the UPI settings.'); }
  };
  useEffect(() => { void load(); }, []);

  // Live QR preview of what customers will scan (no amount — checkout adds it).
  const previewVpa = vpa.trim();
  const previewOk = VPA_RE.test(previewVpa);
  useEffect(() => {
    let live = true;
    if (!previewOk) { setQr(null); return; }
    const url = `upi://pay?${new URLSearchParams({ pa: previewVpa, pn: payee.trim() || BRAND.name, cu: 'INR', tn: `${BRAND.name} booking` })}`;
    QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: 'M' })
      .then((d: string) => { if (live) setQr(d); })
      .catch((e: unknown) => captureException(e, { where: 'admin2_upi_qr' }));
    return () => { live = false; };
  }, [previewVpa, payee, previewOk]);

  async function save() {
    if (vpa.trim() && !previewOk) { toast.error('That doesn’t look like a UPI ID. It should look like name@bank.'); return; }
    setSaving(true);
    try {
      const r = await adminCall<Status & { ok: boolean }>('/api/admin/upi-settings', { method: 'PUT', body: { vpa: vpa.trim(), payee_name: payee.trim() } });
      apply(r);
      capture('admin_upi_settings_saved', { vpa_set: Boolean(r.saved.vpa), source: r.active.source, rail_enabled: r.rail.enabled });
      toast.success('UPI ID saved', { description: 'New checkouts use it within a few seconds.' });
    } catch (e) {
      toast.error(e instanceof ApiError ? errMessage(e, e.error) : 'Could not save the UPI settings.');
    } finally { setSaving(false); }
  }

  if (loadError) return <ErrorBox message={loadError} onRetry={() => void load()} />;
  if (!status) return <ListSkeleton rows={3} />;

  const dirty = vpa.trim() !== (status.saved.vpa ?? status.active.vpa ?? '') || payee.trim() !== (status.saved.payee_name ?? status.active.payee_name ?? '');
  const smsAgeDays = status.last_bank_sms_at ? (Date.now() - status.last_bank_sms_at) / 86_400_000 : null;

  const activeVpa = status.active.vpa;

  return (
    <div className="hfa-stack pb-24">
      <div className="hfa-row-wide">
        {/* The painted shop nameplate */}
        <section aria-label="Active UPI ID" className="relative overflow-hidden rounded-[30px] p-[clamp(10px,1.2vw,16px)] shadow-[0_18px_36px_-18px_rgba(10,92,99,.7)]"
          style={{ background: 'linear-gradient(140deg,#0a5c63,#0e7c86 60%,#16a3ad)' }}>
          <span aria-hidden="true" className="absolute left-5 top-4 h-3 w-3 rounded-full bg-[#fbbf24] shadow-inner" />
          <span aria-hidden="true" className="absolute right-5 top-4 h-3 w-3 rounded-full bg-[#fbbf24] shadow-inner" />
          <div className="relative flex flex-col gap-4 rounded-[22px] border-[3px] border-dashed border-[#fbbf24] px-[clamp(16px,2vw,32px)] py-[clamp(22px,2.4vw,36px)] text-white lg:flex-row lg:items-center lg:justify-between">
            <span aria-hidden="true" className="pointer-events-none absolute -bottom-4 -right-4 opacity-90"><Marigold size={92} tone={1} /></span>
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-dash text-[clamp(16px,14px+.5vw,20px)] font-bold uppercase tracking-[.08em] text-[#ffe9a8]">UPI payments</h2>
                {status.rail.enabled
                  ? <span className="hfa-chip hfa-c-tea" style={{ background: '#fff' }}><CheckCircle2 className="h-4 w-4" aria-hidden /> Taking payments</span>
                  : <span className="hfa-chip hfa-c-rani" style={{ background: '#fff' }}><AlertTriangle className="h-4 w-4" aria-hidden /> Not taking payments</span>}
              </div>
              <div className="break-all font-dash font-black leading-tight text-[#fff7da]" style={{ fontSize: 'clamp(26px, 12px + 2.6vw, 56px)', textShadow: '0 3px 0 rgba(0,0,0,.22)' }}>
                {activeVpa ?? '—'}
              </div>
              {activeVpa && <CopyValue value={activeVpa} label="UPI ID" className="text-white [&_button]:bg-white/20 [&_button]:text-white [&_button:hover]:bg-white/30 [&_span]:!font-bold" />}
              {!status.rail.enabled && status.rail.reason && (
                <p className="rounded-xl bg-white p-3 text-[14px] font-bold text-destructive">{RAIL_REASON[status.rail.reason] ?? status.rail.reason}</p>
              )}
              <p className="text-[14px] font-semibold text-[#d9f3f5]">
                Customers pay by scanning the QR at checkout: <b className="text-white">{activeVpa ?? '—'}</b>
                {status.active.source === 'env' && ' (built-in default — save one below to take over)'}
              </p>
            </div>
            <div className="grid shrink-0 justify-items-center gap-2">
              <div className="grid h-[200px] w-[200px] place-items-center rounded-2xl border-[6px] border-white bg-white shadow-md">
                {qr ? <img src={qr} alt={`UPI QR for ${previewVpa}`} className="h-full w-full rounded-md" /> : <span className="px-3 text-center text-[14px] font-bold text-[var(--a-muted)]">Enter a UPI ID to see the QR</span>}
              </div>
              <span className="max-w-[220px] text-center text-[14px] font-bold text-[#d9f3f5]">Preview — checkout adds the exact amount</span>
            </div>
          </div>
        </section>

        <DesiCard title="Bank SMS phone" tone="gold" corner="marigold" pattern="stripes">
          <p className="text-[14px] font-semibold text-[var(--a-plum)]">
            Last HDFC credit SMS received: <b>{status.last_bank_sms_at ? istDateTime(status.last_bank_sms_at) : 'never'}</b>
            {smsAgeDays !== null && smsAgeDays > 2 && ' — if you have taken payments since, the SMS app is not forwarding.'}
          </p>
          <a href={SMS_COMPANION_APK_URL} className="hfa-btn mt-3" onClick={() => capture('admin_sms_companion_download')}>
            <Smartphone className="h-5 w-5" aria-hidden /> Download the SMS app (APK)
          </a>
          <p className="mt-3 text-[14px] font-semibold text-[var(--a-plum)]">Not on Google Play — open this link on the Android phone that receives HDFC SMS and allow “install unknown apps”. Then enter the device ID, device secret and the last 4 digits of the HDFC account.</p>
        </DesiCard>
      </div>

      <DesiCard title="Your UPI ID" note="Change it here; new checkouts use it within a few seconds." tone="cream" pattern="bahi" corner="jasmine">
        <div className="grid max-w-3xl content-start gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="upi-vpa" className="text-[14px] font-bold">Your UPI ID</Label>
            <Input id="upi-vpa" value={vpa} onChange={(e) => setVpa(e.target.value.replace(/\s/g, ''))} placeholder="yourname@bank" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={vpa.trim() !== '' && !previewOk} className="min-h-[48px] bg-white text-[17px] font-bold" />
            {vpa.trim() !== '' && !previewOk && <p className="text-[14px] font-bold text-destructive">Should look like name@bank.</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="upi-payee" className="text-[14px] font-bold">Name customers see in their UPI app</Label>
            <Input id="upi-payee" value={payee} maxLength={60} onChange={(e) => setPayee(e.target.value)} placeholder={BRAND.name} className="min-h-[48px] bg-white text-[17px] font-bold" />
          </div>
          <div className="rounded-2xl border-2 border-dashed border-[#f59e0b] bg-[#fff1d6] p-3 text-[14px] font-semibold leading-relaxed text-[var(--a-plum)]">
            This UPI ID must pay into the <b>same HDFC account</b> the SMS phone is watching. Payments are confirmed only when that
            account’s credit SMS arrives and matches the customer’s 12-digit UPI reference — money sent anywhere else can’t be confirmed.
          </div>
        </div>
      </DesiCard>

      <DesiCard title="How a payment gets confirmed" note="Nothing changes for the customer when you switch UPI ID." tone="lav" corner="hibiscus" pattern="dots">
        <DesiJourney label="How a payment gets confirmed" steps={[
          { title: 'Customer scans', note: 'The checkout QR carries your UPI ID and the exact amount', tone: 'rani' },
          { title: 'Pays and enters UTR', note: 'The 12-digit UPI reference from their app', tone: 'gold' },
          { title: 'Bank SMS arrives', note: 'HDFC credit SMS, forwarded by the SMS phone', tone: 'lav' },
          { title: 'Matched, confirmed', note: 'SMS and UTR agree, so the booking is released', tone: 'tea' },
        ]} />
      </DesiCard>

      <div className="hfa-card hfa-t-cream sticky bottom-[calc(var(--dash-tabbar-h,0px)+12px)] z-10 flex flex-wrap items-center gap-3 !py-3 backdrop-blur sm:bottom-4">
        <button type="button" className="hfa-btn tea" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />} {saving ? 'Saving…' : 'Save UPI ID'}
        </button>
        <span className="text-[14px] font-semibold text-[var(--a-muted)]">
          {dirty ? 'Unsaved changes' : status.saved.updated_at ? `Last changed ${istDateTime(status.saved.updated_at)}` : 'Using the built-in default'}
        </span>
      </div>
    </div>
  );
}
