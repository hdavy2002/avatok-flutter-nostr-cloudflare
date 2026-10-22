/* AI assistant › Knowledge — [SAATHUM-PREETI-1 2026-09-30]
 * Uploaded files (pdf, docx, txt, md, csv, html ≤20 MB) and the site pages/articles synced into her
 * knowledge. Polls while anything is uploading or indexing. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Loader2, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { errMessage, istDateTime } from './adminApi';
import { ErrorBox, ListSkeleton } from './peopleKit';
import { aiApi, uploadKnowledgeFile, type AdminAiFile, type AdminAiKnowledgeDoc } from './aiApi';
import { DesiChip, DesiEmpty, Marigold } from './desi';
import { HINT, Section, TINT, type TintKey } from './AiKit';

const MAX = 20 * 1024 * 1024;
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html',
};
const mimeFor = (f: File): string | null => TYPES[(f.name.split('.').pop() ?? '').toLowerCase()] ?? null;

const STATUS: Record<string, { label: string; tone: 'tea' | 'gold' | 'rani' | 'lav' | 'grey' | 'red' }> = {
  uploading: { label: 'Uploading', tone: 'lav' },
  indexing: { label: 'Indexing', tone: 'lav' },
  ready: { label: 'Ready', tone: 'tea' },
  failed: { label: 'Failed', tone: 'red' },
  needs_review: { label: 'Needs review', tone: 'gold' },
};
function StatusChip({ s }: { s: string }) {
  const m = STATUS[s] ?? { label: s, tone: 'grey' as const };
  return <DesiChip tone={m.tone}>{(s === 'uploading' || s === 'indexing') && <Loader2 className="h-4 w-4 animate-spin" />}{m.label}</DesiChip>;
}
const extTint = (name: string): TintKey => {
  const e = (name.split('.').pop() ?? '').toLowerCase();
  return e === 'pdf' ? 'rani' : e === 'docx' ? 'lav' : e === 'csv' ? 'gold' : e === 'html' || e === 'htm' ? 'cream' : 'tea';
};
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export default function AiKnowledge() {
  const [files, setFiles] = useState<AdminAiFile[] | null>(null);
  const [docs, setDocs] = useState<AdminAiKnowledgeDoc[] | null>(null);
  const [fErr, setFErr] = useState<string | null>(null);
  const [dErr, setDErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [up, setUp] = useState(0);
  const [syncing, setSyncing] = useState<'sync' | 'full' | null>(null);
  const [del, setDel] = useState<AdminAiFile | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    try { setFiles(await aiApi.files()); setFErr(null); }
    catch (e) { captureException(e, { where: 'admin_ai_files_load' }); setFErr('Could not load the files.'); }
  }, []);
  const loadDocs = useCallback(async () => {
    try { setDocs(await aiApi.knowledge()); setDErr(null); }
    catch (e) { captureException(e, { where: 'admin_ai_docs_load' }); setDErr('Could not load the synced pages.'); }
  }, []);
  useEffect(() => { void loadFiles(); void loadDocs(); }, [loadFiles, loadDocs]);

  // Poll while anything is still being processed.
  const working = (files ?? []).some((f) => f.status === 'uploading' || f.status === 'indexing') || up > 0;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => { if (!document.hidden) void loadFiles(); }, 4000);
    return () => clearInterval(t);
  }, [working, loadFiles]);

  async function addFiles(list: FileList | File[]) {
    for (const f of Array.from(list)) {
      const mime = mimeFor(f);
      if (!mime) { toast.error(`${f.name}: use pdf, docx, txt, md, csv or html.`); continue; }
      if (f.size > MAX) { toast.error(`${f.name} is larger than 20 MB.`); continue; }
      setUp((n) => n + 1);
      try {
        await uploadKnowledgeFile(f, mime);
        capture('admin_ai_file_uploaded', { type: mime, kb: Math.round(f.size / 1024) });
        toast.success(`${f.name} uploaded`, { description: 'It is being indexed now.' });
      } catch (e) {
        captureException(e, { where: 'admin_ai_file_upload' });
        toast.error(`${f.name}: ${errMessage(e, 'upload failed')}`);
      } finally { setUp((n) => n - 1); }
    }
    if (input.current) input.current.value = '';
    await loadFiles();
  }

  async function remove(f: AdminAiFile) {
    setDel(null);
    try {
      await aiApi.deleteFile(f.id);
      setFiles((l) => (l ?? []).filter((x) => x.id !== f.id));
      toast.success('File removed');
    } catch (e) { captureException(e, { where: 'admin_ai_file_delete' }); toast.error(errMessage(e, 'Could not delete the file.')); }
  }

  async function sync(full: boolean) {
    setSyncing(full ? 'full' : 'sync');
    try {
      await aiApi.syncKnowledge(full);
      toast.success(full ? 'Full re-sync finished' : 'Sync finished');
      capture('admin_ai_knowledge_sync', { full });
      await loadDocs();
    } catch (e) { captureException(e, { where: 'admin_ai_knowledge_sync' }); toast.error(errMessage(e, 'The sync failed.')); }
    finally { setSyncing(null); }
  }

  return (
    <div className="hfa-stack">
      <Section title="Your files" tone="cream" corner="marigold" pattern="bahi">
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files); }}
          className={cn('relative flex flex-col items-center gap-2 overflow-hidden rounded-3xl border-[3px] border-dashed px-4 py-8 text-center transition-colors', drag ? 'border-[var(--a-rani)] bg-[var(--a-blush)]' : 'border-[var(--a-marigold)] bg-[var(--a-goldtint)]')}
        >
          <span className="pointer-events-none absolute -left-4 -top-5" aria-hidden="true"><Marigold size={64} tone={1} /></span>
          <UploadCloud className="h-10 w-10 text-[var(--a-amber)]" aria-hidden />
          <p className="font-dash text-[16px] font-bold text-foreground">Drop files here</p>
          <p className={HINT}>pdf, docx, txt, md, csv or html · up to 20 MB each</p>
          <input ref={input} type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.html,.htm" className="sr-only" aria-label="Choose files" onChange={(e) => e.target.files && void addFiles(e.target.files)} />
          <Button variant="outline" className="min-h-11 rounded-full bg-white" onClick={() => input.current?.click()} disabled={up > 0}>
            {up > 0 ? <Loader2 className="animate-spin" /> : null} {up > 0 ? 'Uploading…' : 'Choose files'}
          </Button>
        </div>

        <div className="mt-4">
          {fErr ? <ErrorBox message={fErr} onRetry={() => void loadFiles()} /> : !files ? <ListSkeleton rows={2} /> : files.length === 0 ? (
            <DesiEmpty text="No files yet. Upload price lists, FAQs or guides she should know." />
          ) : (
            <ul className="hfa-tiles">
              {files.map((f) => (
                <li key={f.id} className={cn('flex flex-col gap-3 rounded-3xl border-2 p-4 shadow-sm', TINT[extTint(f.file_name)])}>
                  <div className="flex items-start gap-3">
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-[var(--a-plum)] shadow-sm"><FileText className="h-6 w-6" aria-hidden /></span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[15px] font-extrabold text-foreground">{f.file_name}</p>
                      <p className="text-[14px] font-semibold text-muted-foreground">{size(f.size_bytes)} · {istDateTime(f.created_at)}</p>
                      {f.error && <p className="text-[14px] font-bold text-[var(--a-bad)]">{f.error}</p>}
                      {f.status === 'needs_review' && <p className="text-[14px] font-semibold text-muted-foreground">Written before a brand change: check it still reads correctly, or re-upload it.</p>}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <StatusChip s={f.status} />
                    <Button size="icon" variant="ghost" className="h-11 w-11 bg-white/70" aria-label={`Delete ${f.file_name}`} onClick={() => setDel(f)}><Trash2 /></Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        title="Site pages she has read"
        tone="tea"
        corner="jasmine"
        aside={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="min-h-11 rounded-full bg-white" disabled={syncing !== null} onClick={() => void sync(false)}>
              {syncing === 'sync' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync now
            </Button>
            <Button variant="outline" className="min-h-11 rounded-full bg-white" disabled={syncing !== null} onClick={() => void sync(true)}>
              {syncing === 'full' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Full re-sync
            </Button>
          </div>
        }
      >
        <p className={cn(HINT, 'mb-3')}>“Sync now” reads only pages that changed. “Full re-sync” re-reads everything, useful after a brand change.</p>
        {dErr ? <ErrorBox message={dErr} onRetry={() => void loadDocs()} /> : !docs ? <ListSkeleton rows={3} /> : docs.length === 0 ? (
          <DesiEmpty text="Nothing synced yet. Press “Sync now” to read the site's articles and pages." />
        ) : (
          <ul className="hfa-tiles max-h-[480px] overflow-y-auto p-1">
            {docs.map((d, di) => (
              <li key={d.url} className={cn('flex flex-col gap-2 rounded-2xl border-2 p-3.5', di % 2 ? TINT.gold : TINT.lav)}>
                <div className="flex flex-wrap items-center gap-2">
                  <DesiChip tone="plum" className="capitalize">{d.kind}</DesiChip>
                  <StatusChip s={d.status} />
                </div>
                <a href={d.url} target="_blank" rel="noreferrer" className="break-words text-[15px] font-extrabold text-foreground underline-offset-2 hover:underline">{d.title ?? d.url}</a>
                {d.error && <span className="block text-[14px] font-bold text-[var(--a-bad)]">{d.error}</span>}
                <span className="text-[14px] font-semibold text-muted-foreground">{d.synced_at ? istDateTime(d.synced_at) : 'not synced'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <AlertDialog open={!!del} onOpenChange={(o) => { if (!o) setDel(null); }}>
        <AlertDialogContent className="hf-admin-operations">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>{del?.file_name} will be removed and she will stop using it in answers.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => del && void remove(del)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
