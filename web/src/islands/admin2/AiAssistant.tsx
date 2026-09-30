/* AI assistant — [SAATHUM-PREETI-1 2026-09-30] Admin 2 shell for the site's AI chat agent.
 * Tabs: Identity, Behaviour, Knowledge, Incidents, Conversations. The tab lives in ?tab= so a
 * reload (or a shared link) lands on the same one. API: /api/admin/v2/ai/* (routes/admin2_ai.ts). */
import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { capture } from '../../lib/analytics';
import AiIdentity from './AiIdentity';
import AiBehaviour from './AiBehaviour';
import AiKnowledge from './AiKnowledge';
import AiIncidents from './AiIncidents';
import AiConversations from './AiConversations';

const TABS = [
  { key: 'identity', label: 'Identity' },
  { key: 'behaviour', label: 'Behaviour' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'incidents', label: 'Incidents' },
  { key: 'conversations', label: 'Conversations' },
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
    <Tabs value={tab} onValueChange={change}>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList className="h-12 w-max min-w-full justify-start sm:min-w-0">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="h-10 px-4 font-dashbody text-[14px] font-extrabold">{t.label}</TabsTrigger>
          ))}
        </TabsList>
      </div>
      {/* Only the active tab mounts, so background tabs never poll or hold state. */}
      <TabsContent value="identity" className="mt-5">{tab === 'identity' && <AiIdentity />}</TabsContent>
      <TabsContent value="behaviour" className="mt-5">{tab === 'behaviour' && <AiBehaviour />}</TabsContent>
      <TabsContent value="knowledge" className="mt-5">{tab === 'knowledge' && <AiKnowledge />}</TabsContent>
      <TabsContent value="incidents" className="mt-5">{tab === 'incidents' && <AiIncidents />}</TabsContent>
      <TabsContent value="conversations" className="mt-5">{tab === 'conversations' && <AiConversations />}</TabsContent>
    </Tabs>
  );
}
