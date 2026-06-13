/* InboxPanel — the notification feed. GET /api/notifications?limit=30 →
 * { items:[{id,type,title,body,read,created_at}] }; POST /api/notifications/read.
 */
import { useEffect, useMemo, useState } from 'react';
import { getActiveTokenWaited as getActiveToken } from '../../lib/clerk';
import { request } from '../../lib/apiClient';
import { Spinner } from '../../components/Spinner';

type Note = { id: string; type?: string; title?: string; body?: string; read?: boolean; created_at?: number };
const dt = (ms?: number) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function Inner() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [items, setItems] = useState<Note[] | null>(null);
  const [tab, setTab] = useState<'all' | 'unread'>('all');

  useEffect(() => { void (async () => { setToken(await getActiveToken()); setChecked(true); })(); }, []);
  useEffect(() => {
    if (!checked || !token) { if (checked) setItems([]); return; }
    void (async () => {
      try { const r = await request<{ items?: Note[] }>('/api/notifications', { auth: token, query: { limit: 30 } }); setItems(r.items ?? []); }
      catch { setItems([]); }
    })();
  }, [token, checked]);

  const shown = useMemo(() => (items ?? []).filter((n) => tab === 'all' || !n.read), [items, tab]);
  const unread = (items ?? []).filter((n) => !n.read).length;

  async function markAll() {
    if (!token) return;
    setItems((p) => (p ?? []).map((n) => ({ ...n, read: true })));
    try { await request('/api/notifications/read', { method: 'POST', auth: token, body: { all: true } }); } catch { /* */ }
  }

  if (!checked || items === null) return <div className="flex items-center gap-3 p-8"><Spinner size={22} /></div>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setTab('all')} className={`rounded-full border-zine border-ink px-4 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.06em] shadow-zine-xs ${tab === 'all' ? 'bg-ink text-paper' : 'bg-card text-inkSoft'}`}>All</button>
        <button type="button" onClick={() => setTab('unread')} className={`rounded-full border-zine border-ink px-4 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.06em] shadow-zine-xs ${tab === 'unread' ? 'bg-ink text-paper' : 'bg-card text-inkSoft'}`}>Unread{unread ? ` (${unread})` : ''}</button>
        {unread > 0 && <button type="button" onClick={markAll} className="ml-auto rounded-full border-zine border-ink bg-lime px-4 py-1.5 font-mono font-bold uppercase text-[11px] tracking-[0.06em] text-ink shadow-zine-xs hover:-translate-y-[1px] transition-transform duration-zine">Mark all read</button>}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-zine border-zine border-ink bg-paper2 p-8 font-body font-bold text-[15px] text-inkSoft shadow-zine-sm">{tab === 'unread' ? "You're all caught up." : 'No notifications yet.'}</div>
      ) : (
        <div className="overflow-hidden rounded-zine border-zine border-ink bg-card shadow-zine-sm">
          {shown.map((n, i) => (
            <div key={n.id} className={`flex items-start gap-3 p-4 ${i ? 'border-t-zine border-ink' : ''} ${n.read ? '' : 'bg-paper2'}`}>
              <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-zine border-ink ${n.read ? 'bg-paper' : 'bg-coral'}`} />
              <div className="min-w-0 flex-1">
                <div className="font-display font-semibold text-[15px] text-ink">{n.title ?? n.type ?? 'Notification'}</div>
                {n.body && <p className="font-body font-bold text-[13px] text-inkSoft">{n.body}</p>}
              </div>
              <span className="shrink-0 font-mono text-[11px] text-inkMute">{dt(n.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function InboxPanel() { return <Inner />; }
export default InboxPanel;
