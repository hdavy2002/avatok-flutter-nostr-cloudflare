/* Voice guides — [AUMFE-VOICE-ADMIN-1] Admin 2 screen: cards grid + create/edit with tabs.
 * URL: /admin/voice-guides (list) · ?guide=<id>&tab=… (edit) · ?new=1 (create). API: ./api.ts */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, Plus } from 'lucide-react';
import { captureException } from '../../../lib/analytics';
import { Button } from '../../../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { errMessage } from '../adminApi';
import { Empty, ErrorBox, ListSkeleton } from '../peopleKit';
import { Chip, HINT, Section } from '../AiKit';
import { vgApi, STATUSES, type Guide, type VoiceMeta } from './api';
import { GuideCardView } from './GuideCard';
import CardTab from './CardTab';
import PromptTab from './PromptTab';
import KnowledgeTab from './KnowledgeTab';
import CallsTab from './CallsTab';

const TABS = [['card', 'Card'], ['prompt', 'Persona & prompt'], ['knowledge', 'Knowledge'], ['test', 'Test'], ['calls', 'Calls']] as const;
type Tab = (typeof TABS)[number][0];

function readUrl() {
  const u = new URLSearchParams(location.search);
  const tab = u.get('tab') as Tab | null;
  return { guide: u.get('guide') ?? '', isNew: u.get('new') === '1', tab: (TABS.find((t) => t[0] === tab)?.[0] ?? 'card') as Tab };
}
function writeUrl(p: Record<string, string>) {
  const u = new URL(location.origin + location.pathname);
  for (const [k, v] of Object.entries(p)) if (v) u.searchParams.set(k, v);
  history.pushState(null, '', u.toString());
}

export default function VoiceGuides() {
  const [view, setView] = useState(readUrl);
  const [guides, setGuides] = useState<Guide[] | null>(null);
  const [meta, setMeta] = useState<VoiceMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const [g, m] = await Promise.all([vgApi.list(), meta ? Promise.resolve(meta) : vgApi.meta()]);
      setGuides(g); setMeta(m); setErr(null);
    } catch (e) { captureException(e, { where: 'admin_voice_guides_load' }); setErr(errMessage(e, 'Could not load the voice guides.')); }
  }, [meta]);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => setView(readUrl());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  const go = (p: Record<string, string>) => { writeUrl(p); setView(readUrl()); };
  const upsert = (g: Guide) => setGuides((l) => (l ?? []).some((x) => x.id === g.id) ? (l ?? []).map((x) => (x.id === g.id ? { ...x, ...g } : x)) : [...(l ?? []), g]);

  if (err && !guides) return <ErrorBox message={err} onRetry={() => void load()} />;
  if (!guides || !meta) return <ListSkeleton rows={3} />;

  /* ── editor ── */
  if (view.isNew || view.guide) {
    const guide = view.isNew ? null : guides.find((g) => g.id === view.guide) ?? null;
    if (!view.isNew && !guide) return <Empty title="Guide not found" body="It may have been removed." />;
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="lg" onClick={() => go({})}><ArrowLeft /> All guides</Button>
          <h2 className="font-dash text-[22px] font-bold text-grand-teal">{guide ? guide.name : 'New voice guide'}</h2>
        </div>
        {!guide ? (
          <CardTab key="new" guide={null} meta={meta} onSaved={(g) => { upsert(g); go({ guide: g.id, tab: 'prompt' }); }} />
        ) : (
          <Tabs value={view.tab} onValueChange={(t) => go({ guide: guide.id, tab: t })}>
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <TabsList className="h-12 w-max min-w-full justify-start sm:min-w-0">
                {TABS.map(([k, label]) => <TabsTrigger key={k} value={k} className="h-10 px-4 font-dashbody text-[14px] font-extrabold">{label}</TabsTrigger>)}
              </TabsList>
            </div>
            <TabsContent value="card" className="mt-5">{view.tab === 'card' && <CardTab key={guide.id} guide={guide} meta={meta} onSaved={upsert} />}</TabsContent>
            <TabsContent value="prompt" className="mt-5">{view.tab === 'prompt' && <PromptTab guide={guide} onGuide={upsert} />}</TabsContent>
            <TabsContent value="knowledge" className="mt-5">{view.tab === 'knowledge' && <KnowledgeTab guideId={guide.id} />}</TabsContent>
            <TabsContent value="test" className="mt-5">
              {view.tab === 'test' && (
                <Section title="Test call">
                  <p className={HINT}>Opens the real call screen in a new tab. Test calls are free for admins, so nothing is charged. Publish a prompt version first, or the guide will have no persona.</p>
                  <div className="mt-4">
                    <Button asChild variant="accent" size="lg"><a href={`/talk?guide=${encodeURIComponent(guide.id)}&test=1`} target="_blank" rel="noreferrer"><ExternalLink /> Test call</a></Button>
                  </div>
                </Section>
              )}
            </TabsContent>
            <TabsContent value="calls" className="mt-5">{view.tab === 'calls' && <CallsTab guideId={guide.id} />}</TabsContent>
          </Tabs>
        )}
      </div>
    );
  }

  /* ── list ── */
  const shown = guides.filter((g) => (filter ? g.status === filter : true)).sort((a, b) => a.sort - b.sort);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={!filter} onClick={() => setFilter('')}>All</Chip>
        {STATUSES.map((s) => <Chip key={s} active={filter === s} onClick={() => setFilter(filter === s ? '' : s)}><span className="capitalize">{s}</span></Chip>)}
        <span className="flex-1" />
        <Button variant="accent" size="lg" onClick={() => go({ new: '1' })}><Plus /> New voice guide</Button>
      </div>
      {shown.length === 0 ? (
        <Empty title={filter ? `No ${filter} guides` : 'No voice guides yet'} body="Create one to give customers someone to talk to." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((g) => <GuideCardView key={g.id} g={g} stats onClick={() => go({ guide: g.id })} />)}
        </div>
      )}
    </div>
  );
}
