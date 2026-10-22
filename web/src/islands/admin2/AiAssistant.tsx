/* AI assistant — [SAATHUM-PREETI-1 2026-09-30] Admin 2 shell for the site's AI chat agent.
 * Tabs: Identity, Behaviour, Knowledge, Incidents, Conversations. The tab lives in ?tab= so a
 * reload (or a shared link) lands on the same one. API: /api/admin/v2/ai/* (routes/admin2_ai.ts). */
import { useEffect, useState } from 'react';
import { BookOpen, MessagesSquare, ShieldCheck, Siren, UserRound } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { capture } from '../../lib/analytics';
import AiIdentity from './AiIdentity';
import AiBehaviour from './AiBehaviour';
import AiKnowledge from './AiKnowledge';
import AiIncidents from './AiIncidents';
import AiConversations from './AiConversations';

const TABS = [
  { key: 'identity', label: 'Identity', Icon: UserRound, off: 'bg-[var(--a-lavtint,#f1ebff)] text-[var(--a-lav,#6d4fd0)] border-[#e4dafc]' },
  { key: 'behaviour', label: 'Behaviour', Icon: ShieldCheck, off: 'bg-[var(--a-blush,#ffe6ef)] text-[var(--a-rani,#d81b72)] border-[#f6c2d8]' },
  { key: 'knowledge', label: 'Knowledge', Icon: BookOpen, off: 'bg-[var(--a-goldtint,#fff1d6)] text-[var(--a-amber,#b45309)] border-[#f3dfb3]' },
  { key: 'incidents', label: 'Incidents', Icon: Siren, off: 'bg-[#ffe4cf] text-[var(--a-saffron,#ea6a12)] border-[#ffd0a8]' },
  { key: 'conversations', label: 'Conversations', Icon: MessagesSquare, off: 'bg-[var(--a-teatint,#e3f5f6)] text-[var(--a-peacock,#0e7c86)] border-[#cfe9eb]' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function readTab(): TabKey {
  if (typeof window === 'undefined') return 'identity';
  const q = new URLSearchParams(location.search).get('tab') ?? location.hash.replace(/^#/, '');
  return (TABS.find((t) => t.key === q)?.key ?? 'identity') as TabKey;
}

export default function AiAssistant() {
  const [tab, setTab] = useState<TabKey>(readTab);
  useEffect(() => {
    const on = () => setTab(readTab());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const change = (v: string) => {
    const next = v as TabKey;
    setTab(next);
    const u = new URL(location.href);
    u.searchParams.set('tab', next);
    u.hash = '';
    history.replaceState(history.state, '', u.toString());
    capture('admin_ai_tab', { tab: next });
  };
  return (
    <Tabs className="hf-admin-operations" value={tab} onValueChange={change}>
      <TabsList className="mb-1 flex !h-auto w-full flex-wrap justify-start gap-2 !bg-transparent !p-0 sm:gap-3">
        {TABS.map((t) => (
          <TabsTrigger
            key={t.key}
            value={t.key}
            className={`!h-auto min-h-[48px] gap-2 rounded-full border-2 px-4 font-dashbody text-[clamp(14px,13.4px+.2vw,17px)] font-extrabold shadow-sm hover:-translate-y-0.5 sm:px-6 ${t.off} data-[state=active]:!border-[var(--a-plum,#4a1747)] data-[state=active]:!bg-[var(--a-plum,#4a1747)] data-[state=active]:!text-white data-[state=active]:shadow-lg`}
          >
            <t.Icon className="h-5 w-5 shrink-0" aria-hidden />{t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {/* Only the active tab mounts, so background tabs never poll or hold state. */}
      <TabsContent value="identity" className="mt-5">{tab === 'identity' && <AiIdentity />}</TabsContent>
      <TabsContent value="behaviour" className="mt-5">{tab === 'behaviour' && <AiBehaviour />}</TabsContent>
      <TabsContent value="knowledge" className="mt-5">{tab === 'knowledge' && <AiKnowledge />}</TabsContent>
      <TabsContent value="incidents" className="mt-5">{tab === 'incidents' && <AiIncidents />}</TabsContent>
      <TabsContent value="conversations" className="mt-5">{tab === 'conversations' && <AiConversations />}</TabsContent>
    </Tabs>
  );
}
