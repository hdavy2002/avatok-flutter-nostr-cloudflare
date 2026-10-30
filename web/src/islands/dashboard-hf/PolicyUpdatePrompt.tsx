/* [HF-POLICY-WITHDRAW-1] "Our agreements changed" prompt. The worker pins a version (SHA-256) per policy page; when a page
 * changes, GET /api/hf/me/policy-update lists the pages this person has not accepted at the current version. They read
 * the pages, tick the box and accept (POST the same path). "Not now" only hides it for this visit; it returns next load. */
import { useEffect, useState } from 'react';
import { hfCall } from '../../lib/hfCallsApi';
import { capture, captureException } from '../../lib/analytics';
import { Dialog } from './v3/ui';
import { takePrefetch } from './v3/prefetch'; // [HF-DASH-COLD-1]

interface Pending { policy: string; path: string; version: string }
interface Status { required: boolean; note: string; pending: Pending[] }

const LABEL: Record<string, string> = {
  terms: 'Terms of Service', privacy: 'Privacy Policy', disclaimer: 'Disclaimer',
  community: 'Community Guidelines', engagement: 'Rules of Engagement',
};

export default function PolicyUpdatePrompt({ uid }: { uid: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let off = false;
    // [HF-DASH-COLD-1] adopt the read DashboardApp started together with /me (same uid only), else ask now
    const pre = takePrefetch(uid, 'policy') as Promise<Awaited<ReturnType<typeof hfCall<Status>>>> | null;
    (pre ?? hfCall<Status>('GET', '/api/hf/me/policy-update')).then((r) => {
      if (off || !r.ok || !r.data.required) return;
      setStatus(r.data); setOpen(true); capture('hf_policy_update_shown', { count: r.data.pending.length });
    }).catch((e) => captureException(e, { area: 'hf_dashboard', step: 'policy_update' }));
    return () => { off = true; };
  }, [uid]);

  async function accept() {
    if (!status || !agree || busy) return;
    setBusy(true); setError('');
    const acceptedPolicyVersions = Object.fromEntries(status.pending.map((p) => [p.policy, p.version]));
    const r = await hfCall<{ ok: boolean }>('POST', '/api/hf/me/policy-update', { acceptedPolicyVersions });
    setBusy(false);
    if (r.ok) { capture('hf_policy_update_accepted', { count: status.pending.length }); setOpen(false); setStatus(null); return; }
    setError(r.status === 409 ? 'The agreements changed again. Please reload this page and try once more.' : 'We could not save that just now. Please try again.');
  }

  if (!status) return null;
  return <Dialog open={open} onClose={() => setOpen(false)} label="Our agreements changed">
    <h2>Our agreements changed</h2>
    <p>{status.note}</p>
    <p>Please read what changed and accept the new versions to carry on.</p>
    <ul>{status.pending.map((p) => <li key={p.policy}><a href={p.path} target="_blank" rel="noopener">{LABEL[p.policy] ?? p.policy}</a></li>)}</ul>
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '12px 0' }}>
      <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
      <span>I have read these and I accept them.</span>
    </label>
    {error && <p role="alert">{error}</p>}
    <div className="hfd-actions">
      <button type="button" className="hfc-btn hfc-primary" disabled={!agree || busy} onClick={() => void accept()}>{busy ? 'Saving…' : 'Accept'}</button>
      <button type="button" className="hfc-btn" onClick={() => setOpen(false)}>Not now</button>
    </div>
  </Dialog>;
}
