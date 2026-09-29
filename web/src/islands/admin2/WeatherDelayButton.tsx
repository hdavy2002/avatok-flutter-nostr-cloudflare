/* Weather delay notice — [SAATHUM-WEATHER-NOTICE-1 2026-09-29, owner request]
 * Snow/landslides at remote temples can cut the network, so the video (and prasad) is late.
 * One button tells every confirmed buyer of this event by WhatsApp + email.
 *   GET  /api/admin/v2/events/:id/weather-delay  -> {recipients}
 *   POST /api/admin/v2/events/:id/weather-delay  -> {recipients, whatsapp_queued, skipped_no_phone, emails_queued}
 * Confirm step is in-page (no window.confirm). Fonts >= 16px (admin is used on a phone). */
import { useEffect, useState } from 'react';
import { CloudSnow, Loader2, CheckCircle2 } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { Button } from '../../components/ui/button';
import { errMessage } from './adminApi';
import { adminCall } from './peopleKit';

type Result = { recipients: number; whatsapp_queued: number; skipped_no_phone: number; emails_queued: number };

export default function WeatherDelayButton({ eventId }: { eventId: string }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'sending' | 'done'>('idle');
  const [count, setCount] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/admin/v2/events/${encodeURIComponent(eventId)}/weather-delay`;

  useEffect(() => { setStep('idle'); setResult(null); setError(null); }, [eventId]);

  async function ask() {
    setError(null); setStep('confirm'); setCount(null);
    try { setCount((await adminCall<{ recipients: number }>(path)).recipients); }
    catch (e) { captureException(e, { where: 'admin2_weather_count' }); setError(errMessage(e, 'Could not count the customers.')); setStep('idle'); }
  }

  async function send() {
    setStep('sending'); setError(null);
    try {
      const r = await adminCall<Result>(path, { method: 'POST', body: {} });
      capture('admin2_weather_delay_sent', { ...r });
      setResult(r); setStep('done');
    } catch (e) {
      captureException(e, { where: 'admin2_weather_send' });
      setError(errMessage(e, 'Could not send the notice. Please try again.')); setStep('confirm');
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-6" aria-label="Weather delay notice">
      <h2 className="flex items-center gap-2 font-dash text-[20px] font-bold text-grand-teal"><CloudSnow className="h-5 w-5" /> Weather delay</h2>
      <p className="mt-2 text-[16px] font-semibold text-muted-foreground">
        If snow or a landslide has cut the network at the temple, tell everyone who booked this event that the video and prasad will be a little late.
      </p>

      {step === 'idle' && (
        <Button type="button" className="mt-4 min-h-[48px] text-[16px] font-bold" onClick={() => void ask()}>Send weather delay notice</Button>
      )}

      {(step === 'confirm' || step === 'sending') && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900" role="alert">
          <p className="text-[16px] font-bold">
            {count === null ? 'Counting customers…'
              : count === 0 ? 'No confirmed customers have booked this event yet.'
              : `This will send a WhatsApp and an email to ${count} ${count === 1 ? 'customer' : 'customers'} who booked this event. It cannot be undone. Continue?`}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button type="button" className="min-h-[48px] text-[16px] font-bold" disabled={step === 'sending' || !count} onClick={() => void send()}>
              {step === 'sending' ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…</> : 'Yes, send it'}
            </Button>
            <Button type="button" variant="outline" className="min-h-[48px] text-[16px] font-bold" disabled={step === 'sending'} onClick={() => setStep('idle')}>Cancel</Button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4" role="status">
          <p className="flex items-center gap-2 text-[16px] font-bold text-grand-teal"><CheckCircle2 className="h-5 w-5" /> Notice sent</p>
          <ul className="mt-2 grid gap-1 text-[16px] font-semibold">
            <li>Customers: {result.recipients}</li>
            <li>WhatsApp queued: {result.whatsapp_queued}</li>
            <li>No verified WhatsApp number (skipped): {result.skipped_no_phone}</li>
            <li>Emails queued: {result.emails_queued}</li>
          </ul>
          <p className="mt-2 text-[16px] font-semibold text-muted-foreground">WhatsApp messages go out a few at a time over the next minutes. Pressing the button again today will not message anyone twice.</p>
          <Button type="button" variant="outline" className="mt-3 min-h-[48px] text-[16px] font-bold" onClick={() => setStep('idle')}>Done</Button>
        </div>
      )}

      {error && <p className="mt-3 text-[16px] font-bold text-destructive">{error}</p>}
    </section>
  );
}
