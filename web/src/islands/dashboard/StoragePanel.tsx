/* StoragePanel — storage usage + analytics. GET /api/storage/summary. Shape is
 * read defensively (used/quota bytes + optional per-type breakdown).
 */
import { useEffect, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';

function fmtBytes(n?: number) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
const TONES = ['bg-lime', 'bg-blue', 'bg-coral', 'bg-lilac', 'bg-mint'];

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [s, setS] = useState<any | null>(null);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);
  useEffect(() => {
    if (!checked || !token) return;
    void (async () => { try { setS(await request('/api/storage/summary', { auth: token })); } catch { setS({}); } })();
  }, [token, checked]);

  if (!checked || (token && s === null)) return <div className="flex items-center gap-3 p-8"><Spinner size={22} /></div>;

  const used = Number(s?.used_bytes ?? s?.used ?? s?.bytes_used ?? 0);
  const quota = Number(s?.quota_bytes ?? s?.quota ?? s?.limit_bytes ?? 5 * 1024 ** 3);
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const breakdownObj = s?.by_type ?? s?.breakdown ?? s?.types ?? null;
  const breakdown: { label: string; bytes: number }[] = breakdownObj && typeof breakdownObj === 'object'
    ? Object.entries(breakdownObj).map(([k, v]: [string, any]) => ({ label: k, bytes: Number((v && v.bytes) ?? v ?? 0) }))
    : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-zine border-zine border-ink bg-card p-5 shadow-zine-sm">
        <div className="flex items-end justify-between">
          <div>
            <span className="font-mono font-bold uppercase text-[10px] tracking-[0.08em] text-inkSoft">Used</span>
            <div className="font-display font-semibold text-[30px] leading-none text-ink">{fmtBytes(used)}</div>
          </div>
          <span className="font-body font-bold text-[13px] text-inkSoft">of {fmtBytes(quota)} · {pct}%</span>
        </div>
        <div className="mt-3 h-4 w-full overflow-hidden rounded-full border-zine border-ink bg-paper">
          <div className="h-full rounded-full bg-lime" style={{ width: `${pct}%` }} />
        </div>
        {used / quota > 0.9 && <p className="mt-2 font-body font-bold text-[12px] text-coral">You're nearly full — free up space or add storage from your wallet.</p>}
      </div>

      {breakdown.length > 0 && (
        <div>
          <h2 className="mb-3 font-display font-semibold text-[18px] text-ink">By type</h2>
          <div className="flex flex-col gap-2">
            {breakdown.sort((a, b) => b.bytes - a.bytes).map((b, i) => {
              const w = quota > 0 ? Math.min(100, Math.round((b.bytes / quota) * 100)) : 0;
              return (
                <div key={b.label} className="flex items-center gap-3 rounded-zine border-zine border-ink bg-paper2 p-3 shadow-zine-sm">
                  <span className="w-24 truncate font-mono font-bold uppercase text-[11px] text-inkSoft">{b.label}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full border-zine border-ink bg-paper"><div className={`h-full ${TONES[i % TONES.length]}`} style={{ width: `${Math.max(3, w)}%` }} /></div>
                  <span className="w-20 text-right font-display font-semibold text-[13px] text-ink">{fmtBytes(b.bytes)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function StoragePanel() { return <Inner />; }
export default StoragePanel;
