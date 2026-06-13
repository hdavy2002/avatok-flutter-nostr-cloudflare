/* CalendarPanel — AvaCalendar on the web.
 *   GET  /api/calendar/events  → { events:[{title,role,start_at,end_at,price_coins,status}] }
 *   GET  /api/calendar/rules   → { rules:[{id,weekday,start_min,end_min,tz,slot_min}] }
 *   PUT  /api/calendar/rules   → { rules:[{weekday,start_min,end_min,tz,slot_min}] }
 * The actual session (camera/mic) runs in the phone app; here you manage
 * availability and see what's booked.
 */
import { useEffect, useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';

type Ev = { booking_id?: string; title?: string; role?: string; start_at?: number; end_at?: number; price_coins?: number; status?: string };
type Rule = { id?: string; weekday: number; start_min: number; end_min: number; tz?: string; slot_min?: number };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const usd = (c?: number) => (c ? `$${(c / 100).toFixed(0)}` : 'Free');
const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);
  useEffect(() => {
    if (!checked || !token) { if (checked) setEvents([]); return; }
    void (async () => {
      try { const r = await request<{ events?: Ev[] }>('/api/calendar/events', { auth: token }); setEvents(r.events ?? []); } catch { setEvents([]); }
      try { const r = await request<{ rules?: Rule[] }>('/api/calendar/rules', { auth: token }); setRules(r.rules ?? []); } catch { /* */ }
    })();
  }, [token, checked]);

  function addRule() { setRules((p) => [...p, { weekday: 1, start_min: 9 * 60, end_min: 17 * 60, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', slot_min: 60 }]); setSaved(false); }
  function upd(i: number, patch: Partial<Rule>) { setRules((p) => p.map((r, j) => (j === i ? { ...r, ...patch } : r))); setSaved(false); }
  function del(i: number) { setRules((p) => p.filter((_, j) => j !== i)); setSaved(false); }

  async function saveRules() {
    if (!token) return; setSaving(true); setSaved(false);
    try {
      await request('/api/calendar/rules', { method: 'PUT', auth: token, body: { rules: rules.map((r) => ({ weekday: r.weekday, start_min: r.start_min, end_min: r.end_min, tz: r.tz || 'UTC', slot_min: r.slot_min || 60 })) } });
      setSaved(true);
    } catch { alert('Could not save availability — check the times and try again.'); }
    setSaving(false);
  }

  if (!checked || events === null) return <div className="flex items-center gap-3 p-8"><Spinner size={22} /></div>;

  return (
    <div className="flex flex-col gap-8">
      {/* Upcoming */}
      <section>
        <h2 className="mb-3 font-display font-semibold text-[18px] text-ink">Upcoming</h2>
        {events.length === 0 ? (
          <div className="rounded-zine border-zine border-ink bg-paper2 p-6 font-body font-bold text-[14px] text-inkSoft shadow-zine-sm">Nothing booked yet. Open availability below so fans can book you.</div>
        ) : (
          <div className="overflow-hidden rounded-zine border-zine border-ink bg-card shadow-zine-sm">
            {events.map((e, i) => (
              <div key={e.booking_id ?? i} className={`flex flex-wrap items-center gap-3 p-3 ${i ? 'border-t-zine border-ink' : ''}`}>
                <span className={`rounded-full border-zine border-ink px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${e.role === 'host' ? 'bg-lime text-ink' : 'bg-blue text-ink'}`}>{e.role ?? 'event'}</span>
                <span className="min-w-0 flex-1 truncate font-display font-semibold text-[15px] text-ink">{e.title || 'Session'}</span>
                <span className="font-mono text-[12px] text-inkSoft">{fmt(e.start_at)}</span>
                <span className="font-display font-semibold text-[13px] text-blueInk">{usd(e.price_coins)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Availability rules */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-display font-semibold text-[18px] text-ink">Weekly availability</h2>
          <button type="button" onClick={addRule} className="ml-auto rounded-full border-zine border-ink bg-card px-3 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-ink shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">+ Add</button>
          <button type="button" disabled={saving} onClick={saveRules} className="rounded-full border-zine border-ink bg-lime px-4 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-ink shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine disabled:opacity-50">{saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}</button>
        </div>
        {rules.length === 0 ? (
          <div className="rounded-zine border-zine border-ink bg-paper2 p-6 font-body font-bold text-[14px] text-inkSoft shadow-zine-sm">No availability set. Add a window (e.g. Mon 09:00–17:00) so fans can book consults.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {rules.map((r, i) => (
              <div key={r.id ?? i} className="flex flex-wrap items-center gap-2 rounded-zine border-zine border-ink bg-card p-2.5 shadow-zine-sm">
                <select value={r.weekday} onChange={(e) => upd(i, { weekday: Number(e.target.value) })} className="rounded-zineField border-zine border-ink bg-paper px-2 py-1.5 font-mono font-bold text-[12px] text-ink outline-none">
                  {DAYS.map((d, j) => <option key={j} value={j}>{d}</option>)}
                </select>
                <input type="time" value={hhmm(r.start_min)} onChange={(e) => upd(i, { start_min: toMin(e.target.value) })} className="rounded-zineField border-zine border-ink bg-paper px-2 py-1.5 font-mono font-bold text-[12px] text-ink outline-none" />
                <span className="font-mono text-[12px] text-inkSoft">to</span>
                <input type="time" value={hhmm(r.end_min)} onChange={(e) => upd(i, { end_min: toMin(e.target.value) })} className="rounded-zineField border-zine border-ink bg-paper px-2 py-1.5 font-mono font-bold text-[12px] text-ink outline-none" />
                <label className="ml-1 flex items-center gap-1.5 font-mono text-[11px] uppercase text-inkSoft">slot
                  <select value={r.slot_min ?? 60} onChange={(e) => upd(i, { slot_min: Number(e.target.value) })} className="rounded-zineField border-zine border-ink bg-paper px-2 py-1.5 font-mono font-bold text-[12px] text-ink outline-none">
                    {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m}m</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => del(i)} className="ml-auto rounded-zineField border-zine border-ink bg-paper px-2.5 py-1.5 font-mono font-bold text-[12px] text-coral shadow-zine-xs" aria-label="Remove">✕</button>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 font-body font-bold text-[12px] text-inkSoft">Times are in your local timezone. Sessions run in the AvaTOK app.</p>
      </section>
    </div>
  );
}

export function CalendarPanel() { return <ClerkIsland><Inner /></ClerkIsland>; }
export default CalendarPanel;
