/* Voice guides › Calls — [AUMFE-VOICE-ADMIN-1] sessions inbox; a row opens transcript, memories and charges. */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { captureException } from '../../../lib/analytics';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { errMessage, istDateTime } from '../adminApi';
import { Empty, ErrorBox, ListSkeleton } from '../peopleKit';
import { Section } from '../AiKit';
import { vgApi, type SessionDetail, type SessionRow } from './api';
import { rupees } from './GuideCard';

/** Transcript / memories / charges shapes are not pinned down, so read them defensively. */
function line(x: unknown): { who: string; text: string } {
  if (typeof x === 'string') return { who: '', text: x };
  const o = (x ?? {}) as Record<string, unknown>;
  return { who: String(o.role ?? o.speaker ?? o.kind ?? ''), text: String(o.text ?? o.content ?? o.summary ?? o.fact ?? o.memory ?? o.reason ?? JSON.stringify(o)) };
}
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : typeof x === 'string' && x ? x.split('\n') : []);

function Detail({ sid }: { sid: string }) {
  const [d, setD] = useState<SessionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setD(await vgApi.session(sid)); setErr(null); }
    catch (e) { captureException(e, { where: 'admin_voice_session_load' }); setErr(errMessage(e, 'Could not load this call.')); }
  }, [sid]);
  useEffect(() => { void load(); }, [load]);
  if (err) return <ErrorBox message={err} onRetry={() => void load()} />;
  if (!d) return <ListSkeleton rows={2} />;
  const block = (title: string, items: unknown[], empty: string) => (
    <div>
      <p className="mb-1.5 font-dash text-[15px] font-bold text-foreground">{title}</p>
      {items.length === 0 ? <p className="text-[13.5px] font-semibold text-muted-foreground">{empty}</p> : (
        <ul className="grid max-h-[360px] gap-1.5 overflow-y-auto">
          {items.map((it, i) => { const l = line(it); return (
            <li key={i} className="rounded-md bg-muted/60 px-3 py-2 text-[14px] font-semibold text-foreground">
              {l.who && <span className="mr-2 text-[12px] font-extrabold uppercase tracking-wide text-muted-foreground">{l.who}</span>}{l.text}
            </li>
          ); })}
        </ul>
      )}
    </div>
  );
  return (
    <div className="grid gap-4 rounded-lg border border-border/70 bg-background p-3 lg:grid-cols-3">
      <div className="lg:col-span-2">{block('Transcript', arr(d.transcript), 'No transcript was kept.')}</div>
      <div className="grid content-start gap-4">
        {block('Memories saved', arr(d.memories), 'Nothing saved from this call.')}
        {block('Charges', arr(d.charges), 'No charges.')}
      </div>
    </div>
  );
}

export default function CallsTab({ guideId }: { guideId: string }) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (c?: string) => {
    if (c) setMore(true);
    try {
      const r = await vgApi.sessions(guideId, c);
      setRows((o) => (c ? [...(o ?? []), ...(r.sessions ?? [])] : r.sessions ?? []));
      setCursor(r.cursor ?? null); setErr(null);
    } catch (e) { captureException(e, { where: 'admin_voice_sessions_load' }); setErr(errMessage(e, 'Could not load the calls.')); }
    finally { setMore(false); }
  }, [guideId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <Section title="Calls">
      {err && !rows ? <ErrorBox message={err} onRetry={() => void load()} /> : !rows ? <ListSkeleton rows={4} /> : rows.length === 0 ? (
        <Empty title="No calls yet" body="Calls to this guide will show up here." />
      ) : (
        <ul className="grid gap-2">
          {rows.map((s) => (
            <li key={s.id} className="grid gap-2">
              <button type="button" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}
                className="grid min-h-[44px] w-full gap-1 rounded-lg border border-border/70 bg-background px-3 py-2.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[14.5px] font-extrabold text-foreground">{s.name ?? 'No name'}</span>
                  {s.email && <span className="text-[13px] font-semibold text-muted-foreground">{s.email}</span>}
                  <span className="flex-1" />
                  <Badge variant="outline" className="capitalize">{s.status}</Badge>
                </span>
                <span className="text-[13px] font-semibold text-muted-foreground">{istDateTime(s.started_at)} · {s.minutes} min · {rupees(s.cost_tokens)} charged</span>
                {s.summary && <span className="line-clamp-2 text-[14px] font-semibold text-foreground">{s.summary}</span>}
              </button>
              {open === s.id && <Detail sid={s.id} />}
            </li>
          ))}
        </ul>
      )}
      {cursor && <div className="mt-3 flex justify-center"><Button variant="outline" size="lg" disabled={more} onClick={() => void load(cursor)}>{more && <Loader2 className="animate-spin" />} Load more</Button></div>}
    </Section>
  );
}
