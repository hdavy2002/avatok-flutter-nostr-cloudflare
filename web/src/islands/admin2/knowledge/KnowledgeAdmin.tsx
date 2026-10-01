/* Tradition library — [AUMFE-KNOWLEDGE-ADMIN-UI-1 2026-10-01] Admin 2 shell for the shared knowledge layer
 * (the reviewed tradition text and per-product notes the AI and the shop's "Why this?" read from).
 * Tabs: Library, Product notes, Search test. The tab lives in ?tab= so a reload lands on the same one.
 * API: /api/admin/v2/knowledge/* (routes/admin2_knowledge.ts). */
import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { capture } from '../../../lib/analytics';
import LibraryTab from './LibraryTab';
import ProductNotesTab from './ProductNotesTab';
import SearchTestTab from './SearchTestTab';

const TABS = [
  { key: 'library', label: 'Library' },
  { key: 'notes', label: 'Product notes' },
  { key: 'search', label: 'Search test' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function readTab(): TabKey {
  if (typeof window === 'undefined') return 'library';
  const q = new URLSearchParams(location.search).get('tab') ?? location.hash.replace(/^#/, '');
  return (TABS.find((t) => t.key === q)?.key ?? 'library') as TabKey;
}

export default function KnowledgeAdmin() {
  const [tab, setTab] = useState<TabKey>(readTab);
  useEffect(() => {
    capture('admin_knowledge_view', { tab });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit; tab changes emit their own view below
  }, []);
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
    capture('admin_knowledge_view', { tab: next });
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
      {/* Only the active tab mounts, so background tabs never fetch. */}
      <TabsContent value="library" className="mt-5">{tab === 'library' && <LibraryTab />}</TabsContent>
      <TabsContent value="notes" className="mt-5">{tab === 'notes' && <ProductNotesTab />}</TabsContent>
      <TabsContent value="search" className="mt-5">{tab === 'search' && <SearchTestTab />}</TabsContent>
    </Tabs>
  );
}
