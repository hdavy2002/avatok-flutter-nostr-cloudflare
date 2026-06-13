/* IdentityPanel — the trust ladder (L0–L3). GET /api/identity/level →
 * { level, handle?, email?, email_verified?, kyc? }. Document KYC can be started
 * on web (POST /api/id/session → opens hosted flow); liveness is phone-only.
 */
import { useEffect, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';

type Level = { level?: number; handle?: string | null; email?: string | null; email_verified?: boolean; kyc?: string | null };

const STEPS = [
  { lvl: 0, label: 'Guest handle', tone: 'bg-paper2' },
  { lvl: 1, label: 'Email + password', tone: 'bg-mint' },
  { lvl: 2, label: 'Liveness (in app)', tone: 'bg-blue' },
  { lvl: 3, label: 'Document KYC → Creator', tone: 'bg-lime' },
];

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [lvl, setLvl] = useState<Level | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);
  useEffect(() => {
    if (!checked || !token) return;
    void (async () => { try { setLvl(await request<Level>('/api/identity/level', { auth: token })); } catch { setLvl({ level: 0 }); } })();
  }, [token, checked]);

  async function startKyc() {
    if (!token) return; setBusy(true);
    try {
      const r = await request<{ url?: string; client_secret?: string }>('/api/id/session', { method: 'POST', auth: token, body: { provider: 'stripe' } });
      if (r.url) location.href = r.url; else alert('Verification started — continue in the app to finish.');
    } catch { alert('Could not start verification right now.'); }
    setBusy(false);
  }

  if (!checked || (token && lvl === null)) return <div className="flex items-center gap-3 p-8"><Spinner size={22} /></div>;
  const cur = lvl?.level ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-4 rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
        <div className="flex h-14 w-14 items-center justify-center rounded-zine border-zine border-ink bg-lime font-display text-[24px] font-semibold text-ink shadow-zine-xs">L{cur}</div>
        <div>
          <div className="font-display font-semibold text-[20px] text-ink">{cur >= 3 ? 'Verified creator' : cur === 2 ? 'Verified' : cur === 1 ? 'Member' : 'Guest'}</div>
          <div className="font-body font-bold text-[13px] text-inkSoft">{lvl?.handle ? `@${lvl.handle}` : ''}{lvl?.email ? ` · ${lvl.email}${lvl.email_verified ? ' ✓' : ''}` : ''}</div>
        </div>
        {cur < 3 && <button type="button" disabled={busy} onClick={startKyc} className="ml-auto rounded-full border-zine border-ink bg-lime px-5 py-2.5 font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-ink shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine disabled:opacity-50">{busy ? 'Starting…' : 'Verify identity'}</button>}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {STEPS.map((s) => {
          const done = cur >= s.lvl;
          return (
            <div key={s.lvl} className={`flex items-center gap-3 rounded-zine border-zine border-ink ${done ? s.tone : 'bg-paper2'} p-4 shadow-zine-sm`}>
              <span className={`flex h-8 w-8 items-center justify-center rounded-zineBadge border-zine border-ink ${done ? 'bg-ink text-paper' : 'bg-card text-inkMute'} font-mono text-[13px] font-bold`}>{done ? '✓' : s.lvl}</span>
              <span className="font-body font-extrabold text-[14px] text-ink">{s.label}</span>
            </div>
          );
        })}
      </div>
      <p className="font-body font-bold text-[13px] text-inkSoft">Document KYC unlocks creator payouts. The liveness selfie check uses your camera, so it runs in the AvaTOK phone app.</p>
    </div>
  );
}

export function IdentityPanel() { return <ClerkIsland><Inner /></ClerkIsland>; }
export default IdentityPanel;
