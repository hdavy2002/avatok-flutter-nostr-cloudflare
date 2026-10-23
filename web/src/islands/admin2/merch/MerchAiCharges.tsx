/* MerchAiCharges — [HF-MERCH-STUDIO-2] Admin page for AI pictures: charge per picture, on/off switch, stats and recent pictures.
 * Worker: GET|PUT /api/admin/merch/ai (src/routes/admin2_merch.ts). Money on the wire is paise; the charge field is whole rupees. */
import { useCallback, useEffect, useState } from 'react';
import { Banner, Empty, adminCall, click, dateIST, fail, money, usePageView } from './merchKit';

interface AiRecent { genId: string; uid: string; sellerName: string | null; prompt: string; style: string | null; status: string; chargePaise: number; artUrl: string | null; error: string | null; createdAt: number }
interface AiData {
  ok?: boolean; enabled: boolean; chargeRupees: number; tableReady: boolean;
  stats: { today: { count: number; chargedPaise: number }; last30: { count: number; chargedPaise: number; refundedPaise: number } };
  recent: AiRecent[];
}

const STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  done: { label: 'Done', bg: 'var(--a-lavtint)', fg: 'var(--a-lav)' },
  failed: { label: 'Failed', bg: '#fde3e6', fg: 'var(--a-bad)' },
  refunded: { label: 'Refunded', bg: 'var(--a-goldtint)', fg: 'var(--a-amber)' },
  charging: { label: 'Working', bg: 'var(--a-blush)', fg: 'var(--a-rani)' },
  generating: { label: 'Working', bg: 'var(--a-blush)', fg: 'var(--a-rani)' },
};
const CSS = `
.hf-admin .ai-stats{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))}
.hf-admin .ai-stat{background:#fff;border:1.5px solid var(--a-line);border-radius:26px;padding:14px 18px;box-shadow:var(--a-shadow)}
.hf-admin .ai-stat b{display:block;font-family:'Comfortaa',sans-serif;font-size:24px;color:var(--a-plum)}
.hf-admin .ai-stat span{font-size:14px;color:var(--a-muted);font-weight:700}
.hf-admin .ai-switch{position:relative;width:56px;height:32px;border-radius:999px;border:0;cursor:pointer;background:#e5d7e2;transition:background .2s;flex:none}
.hf-admin .ai-switch[aria-checked=true]{background:var(--a-rani)}
.hf-admin .ai-switch i{position:absolute;top:4px;left:4px;width:24px;height:24px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 4px #0003}
.hf-admin .ai-switch[aria-checked=true] i{transform:translateX(24px)}
.hf-admin .ai-switch:focus-visible{outline:3px solid var(--a-lav);outline-offset:2px}
.hf-admin .ai-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,19rem),1fr))}
.hf-admin .ai-card{display:grid;grid-template-columns:84px 1fr;gap:12px;background:#fff;border:1.5px solid var(--a-line);border-radius:26px;padding:12px;box-shadow:var(--a-shadow)}
.hf-admin .ai-card img,.hf-admin .ai-card .ph{width:84px;height:84px;border-radius:18px;object-fit:cover;background:var(--a-blush)}
.hf-admin .ai-card .who{font-weight:800;font-size:15px;color:var(--a-ink)}
.hf-admin .ai-card .meta{font-size:14px;color:var(--a-muted)}
.hf-admin .ai-card .pr{font-size:14px;color:var(--a-ink);margin:4px 0 0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hf-admin .ai-card .pr.open{display:block;-webkit-line-clamp:unset}
.hf-admin .ai-card button.more{background:none;border:0;padding:0;color:var(--a-lav);font:inherit;font-size:14px;font-weight:800;cursor:pointer}
.hf-admin .ai-pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:14px;font-weight:800;margin-right:6px}
.hf-admin .ai-err{font-size:14px;color:var(--a-bad);margin:4px 0 0}
`;

export default function MerchAiCharges() {
  usePageView('ai-charges');
  const [data, setData] = useState<AiData | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [text, setText] = useState('10');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const adopt = (d: AiData) => { setData(d); setEnabled(d.enabled); setText(String(d.chargeRupees)); };
  const load = useCallback(async () => {
    setError(null);
    try { adopt(await adminCall<AiData>('/api/admin/merch/ai')); } catch (e) { setError(fail('merch_ai_load', e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const t = text.trim();
  const n = Number(t);
  const valid = t !== '' && /^\d+$/.test(t) && Number.isInteger(n) && n >= 0 && n <= 500;
  const dirty = !!data && (enabled !== data.enabled || (valid && n !== data.chargeRupees));

  const save = async () => {
    if (!data || !valid) return;
    click('merch_ai_charges_save_clicked', { enabled, charge_rupees: n });
    setState('saving'); setError(null);
    try {
      const r = await adminCall<{ enabled: boolean; chargeRupees: number; tableReady: boolean }>('/api/admin/merch/ai', { method: 'PUT', body: { enabled, chargeRupees: n } });
      setData({ ...data, enabled: r.enabled, chargeRupees: r.chargeRupees, tableReady: r.tableReady });
      setEnabled(r.enabled); setText(String(r.chargeRupees)); setState('saved');
    } catch (e) { setError(fail('merch_ai_save', e)); setState('failed'); }
  };

  if (!data) return <div className="hfa-stack"><style>{CSS}</style>{error ? <Banner tone="error">{error}</Banner> : <p className="mx-empty" role="status">Loading AI charges…</p>}</div>;
  const s = data.stats;
  const when = (ms: number) => dateIST(ms < 1e12 ? ms * 1000 : ms);
  return (
    <div className="hfa-stack">
      <style>{CSS}</style>
      {error && <Banner tone="error">{error}</Banner>}
      {!data.tableReady && <Banner tone="warn">The AI table is not set up yet — AI pictures are switched off until it is.</Banner>}
      <section>
        <h2 className="mx-h">Charge</h2>
        <div className="mx-set">
          <div className="row"><label htmlFor="ai-charge">Charge per AI picture (₹)</label>
            <span><input id="ai-charge" className="mx-in" inputMode="numeric" value={text} aria-invalid={!valid} onChange={(e) => { setText(e.target.value); setState('idle'); }} /></span></div>
          <div className="hint">Influencers pay this from their paid wallet money for every AI picture, including every change. If a picture fails, they get it back automatically. 0 = free.{!valid ? ' Enter a whole number from 0 to 500.' : ''}</div>
        </div>
        <div className="mx-set">
          <div className="row"><label htmlFor="ai-on">AI pictures are on</label>
            <button id="ai-on" type="button" role="switch" aria-checked={enabled} className="ai-switch" onClick={() => { setEnabled(!enabled); setState('idle'); }}><i /></button></div>
          <div className="hint">Off hides “Create with AI” from influencers.</div>
        </div>
        <div className="mx-acts" style={{ marginTop: 16 }}>
          <button type="button" className="hfa-btn rani" disabled={state === 'saving' || !valid || !dirty} onClick={() => void save()}>{state === 'saving' ? 'Saving…' : 'Save'}</button>
          {state === 'saved' && !dirty && <span role="status" style={{ fontWeight: 800, fontSize: 15, color: 'var(--a-lav)' }}>Saved</span>}
          {state === 'failed' && <span role="alert" style={{ fontWeight: 800, fontSize: 15, color: 'var(--a-bad)' }}>Could not save</span>}
        </div>
      </section>
      <section>
        <h2 className="mx-h">How it is going</h2>
        <div className="ai-stats">
          <div className="ai-stat"><b>{s.today.count}</b><span>Pictures today</span></div>
          <div className="ai-stat"><b>{money(s.today.chargedPaise)}</b><span>Charged today</span></div>
          <div className="ai-stat"><b>{s.last30.count}</b><span>Pictures, last 30 days</span></div>
          <div className="ai-stat"><b>{money(s.last30.chargedPaise)}</b><span>Charged, last 30 days</span></div>
          <div className="ai-stat"><b>{money(s.last30.refundedPaise)}</b><span>Refunded, last 30 days</span></div>
        </div>
      </section>
      <section>
        <h2 className="mx-h">Recent AI pictures</h2>
        {!data.recent.length ? <Empty>No AI pictures yet.</Empty> : (
          <div className="ai-grid">
            {data.recent.map((g) => {
              const st = STATUS[g.status] ?? { label: g.status, bg: 'var(--a-lavtint)', fg: 'var(--a-lav)' };
              const long = g.prompt.length > 90;
              return (
                <article className="ai-card" key={g.genId}>
                  {g.artUrl ? <img src={g.artUrl} alt="" loading="lazy" /> : <div className="ph" aria-hidden="true" />}
                  <div>
                    <div className="who">{g.sellerName || 'Unknown seller'}</div>
                    <div className="meta"><span className="ai-pill" style={{ background: st.bg, color: st.fg }}>{st.label}</span>{money(g.chargePaise)}{g.style ? ` · ${g.style}` : ''}</div>
                    <p className={`pr${open[g.genId] ? ' open' : ''}`}>{g.prompt}</p>
                    {long && <button type="button" className="more" onClick={() => setOpen({ ...open, [g.genId]: !open[g.genId] })}>{open[g.genId] ? 'Show less' : 'Show more'}</button>}
                    {g.error && <p className="ai-err">{g.error}</p>}
                    <div className="meta">{when(g.createdAt)}</div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
