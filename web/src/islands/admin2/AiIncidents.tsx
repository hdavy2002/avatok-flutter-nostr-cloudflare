/* AI assistant › Incidents — [SAATHUM-PREETI-1 2026-09-30]
 * Short notices she must mention ("event delayed by rain") for one event or site-wide.
 * Event picker reuses GET /api/admin/v2/events (upcoming + live tabs, as AdminEvents does). */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { adminApi, errMessage, istDateTime } from './adminApi';
import { eventsPath, type EventsListResponse } from './eventsApi';
import { Empty, ErrorBox, ListSkeleton } from './peopleKit';
import { aiApi, type AdminAiIncident } from './aiApi';
import { HINT, LABEL, Section, TEXTAREA } from './AiKit';

const SITE = '__site__';
const SELECT = 'h-11 w-full rounded-md border border-input bg-background px-3 font-dashbody text-[15px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function AiIncidents() {
  const [items, setItems] = useState<AdminAiIncident[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [events, setEvents] = useState<{ id: string; title: string }[]>([]);
  const [evErr, setEvErr] = useState(false);
  const [target, setTarget] = useState(SITE);
  const [message, setMessage] = useState('');
  const [expires, setExpires] = useState(''); // datetime-local, IST
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<AdminAiIncident | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try { setItems((await aiApi.incidents()).sort((a, b) => b.created_at - a.created_at)); }
    catch (e) { captureException(e, { where: 'admin_ai_incidents_load' }); setErr('Could not load the incidents.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const seen = new Map<string, string>();
        for (const tab of ['live', 'upcoming'] as const) {
          const r = await adminApi<EventsListResponse>(eventsPath(), { query: { tab } });
          for (const e of r.items ?? []) seen.set(e.id, e.title);
        }
        if (live) setEvents([...seen].map(([id, title]) => ({ id, title })));
      } catch (e) { captureException(e, { where: 'admin_ai_incidents_events' }); if (live) setEvErr(true); }
    })();
    return () => { live = false; };
  }, []);

  async function create() {
    const msg = message.trim();
    if (msg.length < 3) { toast.error('Write the notice first.'); return; }
    let exp: number | null = null;
    if (expires) {
      exp = Date.parse(`${expires}:00+05:30`);
      if (!Number.isFinite(exp) || exp <= Date.now()) { toast.error('The end time must be in the future.'); return; }
    }
    setBusy(true);
    try {
      await aiApi.createIncident({ listing_id: target === SITE ? null : target, message: msg, expires_at: exp });
      capture('admin_ai_incident_created', { site_wide: target === SITE, expires: exp != null });
      toast.success('Incident added', { description: 'She will mention it when it is relevant.' });
      setMessage(''); setExpires(''); setTarget(SITE);
      await load();
    } catch (e) { captureException(e, { where: 'admin_ai_incident_create' }); toast.error(errMessage(e, 'Could not add the incident.')); }
    finally { setBusy(false); }
  }

  async function remove(i: AdminAiIncident) {
    setDel(null);
    try { await aiApi.deleteIncident(i.id); setItems((l) => (l ?? []).filter((x) => x.id !== i.id)); toast.success('Incident removed'); }
    catch (e) { captureException(e, { where: 'admin_ai_incident_delete' }); toast.error(errMessage(e, 'Could not remove it.')); }
  }

  const now = Date.now();
  const active = (items ?? []).filter((i) => i.expires_at == null || i.expires_at > now);
  const recent = (items ?? []).filter((i) => i.expires_at != null && i.expires_at <= now);

  const row = (i: AdminAiIncident, ended: boolean) => (
    <li key={i.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-extrabold text-foreground">{i.listing_title ?? (i.listing_id ? 'Event' : 'Site-wide')}</span>
          <Badge variant={i.source === 'weather_notice' ? 'secondary' : 'outline'}>{i.source === 'weather_notice' ? 'Weather notice' : 'Added by admin'}</Badge>
          {ended && <Badge variant="muted">Ended</Badge>}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-[14px] font-semibold text-foreground">{i.message}</p>
        <p className="mt-1 text-[12.5px] font-semibold text-muted-foreground">
          From {istDateTime(i.starts_at)} · {i.expires_at ? `until ${istDateTime(i.expires_at)}` : 'no end time'}
        </p>
      </div>
      <Button size="icon" variant="ghost" aria-label="Delete incident" onClick={() => setDel(i)}><Trash2 /></Button>
    </li>
  );

  return (
    <div className="space-y-5">
      <Section title="Add an incident">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="inc-target" className={LABEL}>Applies to</Label>
            <select id="inc-target" value={target} onChange={(e) => setTarget(e.target.value)} className={SELECT}>
              <option value={SITE}>Site-wide</option>
              {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select>
            {evErr && <p className="text-[13px] font-bold text-destructive">Could not load events; site-wide still works.</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="inc-exp" className={LABEL}>Ends (optional, India time)</Label>
            <Input id="inc-exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="inc-msg" className={LABEL}>Message</Label>
            <textarea id="inc-msg" rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} className={TEXTAREA} placeholder="For example: Tonight's aarti starts 30 minutes late because of rain." />
            <p className={HINT}>Written for visitors. She repeats it in her own words.</p>
          </div>
          <div>
            <Button variant="accent" onClick={() => void create()} disabled={busy || !message.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add incident
            </Button>
          </div>
        </div>
      </Section>

      <Section title="Active now">
        {err ? <ErrorBox message={err} onRetry={() => void load()} /> : !items ? <ListSkeleton rows={2} /> : active.length === 0 ? <Empty title="No active incidents" body="Add one above when something affects a booking." /> : <ul className="grid gap-2">{active.map((i) => row(i, false))}</ul>}
      </Section>

      {items && recent.length > 0 && (
        <Section title="Recent">
          <ul className="grid gap-2">{recent.slice(0, 20).map((i) => row(i, true))}</ul>
        </Section>
      )}

      <AlertDialog open={!!del} onOpenChange={(o) => { if (!o) setDel(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this incident?</AlertDialogTitle>
            <AlertDialogDescription>She will stop mentioning it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => del && void remove(del)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
