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
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { toast } from '../../components/ui/sonner';
import { istDateTime, errMessage } from './adminApi';
import { ErrorBox, ListSkeleton, adminCall } from './peopleKit';
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

  return (
    <div className="space-y-5 pb-24">
      <section className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-dash text-[20px] font-bold text-grand-teal">UPI payments</h2>
          {status.rail.enabled
            ? <Badge variant="accent"><CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Taking payments</Badge>
            : <Badge variant="destructive"><AlertTriangle className="mr-1 h-3.5 w-3.5" /> Not taking payments</Badge>}
        </div>
        {!status.rail.enabled && status.rail.reason && (
          <p className="mt-2 text-[14px] font-bold text-destructive">{RAIL_REASON[status.rail.reason] ?? status.rail.reason}</p>
        )}
        <p className="mt-2 text-[14px] font-semibold text-muted-foreground">
          Customers pay by scanning the QR at checkout: <b className="text-foreground">{status.active.vpa ?? '—'}</b>
          {status.active.source === 'env' && ' (built-in default — save one below to take over)'}
        </p>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
        <div className="grid gap-6 md:grid-cols-[1fr_auto]">
          <div className="grid content-start gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="upi-vpa" className="text-[14px] font-bold">Your UPI ID</Label>
              <Input id="upi-vpa" value={vpa} onChange={(e) => setVpa(e.target.value.replace(/\s/g, ''))} placeholder="saathum@hdfcbank" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={vpa.trim() !== '' && !previewOk} className="text-[17px] font-bold" />
              {vpa.trim() !== '' && !previewOk && <p className="text-[13px] font-bold text-destructive">Should look like name@bank.</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="upi-payee" className="text-[14px] font-bold">Name customers see in their UPI app</Label>
              <Input id="upi-payee" value={payee} maxLength={60} onChange={(e) => setPayee(e.target.value)} placeholder={BRAND.name} className="text-[17px] font-bold" />
            </div>
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[14px] font-semibold leading-relaxed text-amber-900">
              This UPI ID must pay into the <b>same HDFC account</b> the SMS phone is watching. Payments are confirmed only when that
              account’s credit SMS arrives and matches the customer’s 12-digit UPI reference — money sent anywhere else can’t be confirmed.
            </div>
          </div>
          <div className="grid justify-items-center gap-2">
            <div className="grid h-[220px] w-[220px] place-items-center rounded-xl border-[6px] border-white bg-muted/40 shadow-md">
              {qr ? <img src={qr} alt={`UPI QR for ${previewVpa}`} className="h-full w-full rounded-md" /> : <span className="px-4 text-center text-[13px] font-bold text-muted-foreground">Enter a UPI ID to see the QR</span>}
            </div>
            <span className="text-[13px] font-bold text-muted-foreground">Preview — checkout adds the exact amount</span>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6">
        <h2 className="flex items-center gap-2 font-dash text-[20px] font-bold text-grand-teal"><Smartphone className="h-5 w-5" /> Bank SMS phone</h2>
        <p className="mt-2 text-[14px] font-semibold text-muted-foreground">
          Last HDFC credit SMS received: <b className="text-foreground">{status.last_bank_sms_at ? istDateTime(status.last_bank_sms_at) : 'never'}</b>
          {smsAgeDays !== null && smsAgeDays > 2 && ' — if you have taken payments since, the SMS app is not forwarding.'}
        </p>
        <a href={SMS_COMPANION_APK_URL} className="mt-3 inline-flex h-11 items-center rounded-md bg-primary px-5 text-[14px] font-bold text-primary-foreground no-underline hover:bg-primary/90" onClick={() => capture('admin_sms_companion_download')}>
          Download the SMS app (APK)
        </a>
        <p className="mt-2 text-[13px] font-semibold text-muted-foreground">Not on Google Play — open this link on the Android phone that receives HDFC SMS and allow “install unknown apps”. Then enter the device ID, device secret and the last 4 digits of the HDFC account.</p>
      </section>

      <div className="sticky bottom-[calc(var(--dash-tabbar-h,0px)+12px)] z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur sm:bottom-4">
        <Button variant="accent" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} {saving ? 'Saving…' : 'Save UPI ID'}
        </Button>
        <span className="text-[13px] font-semibold text-muted-foreground">
          {dirty ? 'Unsaved changes' : status.saved.updated_at ? `Last changed ${istDateTime(status.saved.updated_at)}` : 'Using the built-in default'}
        </span>
      </div>
    </div>
  );
}
