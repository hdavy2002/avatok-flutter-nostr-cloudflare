/* Voice guides › Knowledge (RAG) — [AUMFE-VOICE-ADMIN-1] files, a website URL, pasted text; polls while indexing. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Globe, Loader2, RefreshCw, Trash2, Type, UploadCloud } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../../components/ui/alert-dialog';
import { toast } from '../../../components/ui/sonner';
import { errMessage } from '../adminApi';
import { Empty, ErrorBox, ListSkeleton } from '../peopleKit';
import { HINT, Section, TEXTAREA } from '../AiKit';
import { uploadDoc, vgApi, type GuideDoc } from './api';
import { FIELD, Field } from './GuideCard';

const MAX = 10 * 1024 * 1024;
const EXT = ['pdf', 'txt', 'md', 'docx'];
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const busyStatus = (s: string) => s === 'queued' || s === 'indexing';

function Status({ s }: { s: string }) {
  const v = s === 'ready' ? 'accent' : s === 'failed' ? 'destructive' : 'secondary';
  return <Badge variant={v} className="whitespace-nowrap capitalize">{busyStatus(s) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{s}</Badge>;
}

export default function KnowledgeTab({ guideId }: { guideId: string }) {
  const [docs, setDocs] = useState<GuideDoc[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [up, setUp] = useState(0);
  const [url, setUrl] = useState(''); const [urlTitle, setUrlTitle] = useState('');
  const [title, setTitle] = useState(''); const [text, setText] = useState('');
  const [adding, setAdding] = useState<'url' | 'text' | null>(null);
  const [del, setDel] = useState<GuideDoc | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setDocs(await vgApi.docs(guideId)); setErr(null); }
    catch (e) { captureException(e, { where: 'admin_voice_docs_load' }); setErr(errMessage(e, 'Could not load the documents.')); }
  }, [guideId]);
  useEffect(() => { void load(); }, [load]);

  const working = (docs ?? []).some((d) => busyStatus(d.status)) || up > 0;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => clearInterval(t);
  }, [working, load]);

  async function addFiles(list: FileList | File[]) {
    for (const f of Array.from(list)) {
      if (!EXT.includes((f.name.split('.').pop() ?? '').toLowerCase())) { toast.error(`${f.name}: use pdf, txt, md or docx.`); continue; }
      if (f.size > MAX) { toast.error(`${f.name} is larger than 10 MB.`); continue; }
      setUp((n) => n + 1);
      try { await uploadDoc(guideId, f); capture('admin_voice_doc_added', { kind: 'file' }); toast.success(`${f.name} uploaded`, { description: 'It is being indexed now.' }); }
      catch (e) { captureException(e, { where: 'admin_voice_doc_upload' }); toast.error(`${f.name}: ${errMessage(e, 'upload failed')}`); }
      finally { setUp((n) => n - 1); }
    }
    if (input.current) input.current.value = '';
    await load();
  }
  async function addUrl() {
    setAdding('url');
    try { await vgApi.addUrl(guideId, { url: url.trim(), title: urlTitle.trim() || undefined }); capture('admin_voice_doc_added', { kind: 'url' }); setUrl(''); setUrlTitle(''); toast.success('Page added'); await load(); }
    catch (e) { captureException(e, { where: 'admin_voice_doc_url' }); toast.error(errMessage(e, 'Could not add that page.')); }
    finally { setAdding(null); }
  }
  async function addText() {
    setAdding('text');
    try { await vgApi.addText(guideId, { title: title.trim(), text: text.trim() }); capture('admin_voice_doc_added', { kind: 'text' }); setTitle(''); setText(''); toast.success('Text added'); await load(); }
    catch (e) { captureException(e, { where: 'admin_voice_doc_text' }); toast.error(errMessage(e, 'Could not add the text.')); }
    finally { setAdding(null); }
  }
  async function reindex(d: GuideDoc) {
    try { await vgApi.reindex(guideId, d.id); toast.success('Re-indexing'); await load(); }
    catch (e) { captureException(e, { where: 'admin_voice_doc_reindex' }); toast.error(errMessage(e, 'Could not re-index.')); }
  }
  async function remove(d: GuideDoc) {
    setDel(null);
    try { await vgApi.deleteDoc(guideId, d.id); setDocs((l) => (l ?? []).filter((x) => x.id !== d.id)); toast.success('Removed'); }
    catch (e) { captureException(e, { where: 'admin_voice_doc_delete' }); toast.error(errMessage(e, 'Could not delete.')); }
  }

  return (
    <div className="space-y-5">
      <Section title="Add knowledge">
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files); }}
          className={cn('flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors', drag ? 'border-accent bg-accent/10' : 'border-border bg-background')}
        >
          <UploadCloud className="h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="font-dash text-[16px] font-bold text-foreground">Drop files here</p>
          <p className={HINT}>pdf, txt, md or docx · up to 10 MB each</p>
          <input ref={input} type="file" multiple accept=".pdf,.txt,.md,.docx" className="sr-only" aria-label="Choose files" onChange={(e) => e.target.files && void addFiles(e.target.files)} />
          <Button variant="outline" size="lg" onClick={() => input.current?.click()} disabled={up > 0}>{up > 0 && <Loader2 className="animate-spin" />} {up > 0 ? 'Uploading…' : 'Choose files'}</Button>
        </div>
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <div className="grid content-start gap-3 rounded-xl border border-border/70 p-3">
            <p className="flex items-center gap-2 font-dash text-[16px] font-bold"><Globe className="h-4 w-4" aria-hidden /> Website page</p>
            <Field label="URL"><input className={FIELD} value={url} inputMode="url" placeholder="https://" onChange={(e) => setUrl(e.target.value)} /></Field>
            <Field label="Title (optional)"><input className={FIELD} value={urlTitle} onChange={(e) => setUrlTitle(e.target.value)} /></Field>
            <div><Button variant="outline" size="lg" disabled={adding !== null || !/^https?:\/\//i.test(url.trim())} onClick={() => void addUrl()}>{adding === 'url' && <Loader2 className="animate-spin" />} Add page</Button></div>
          </div>
          <div className="grid content-start gap-3 rounded-xl border border-border/70 p-3">
            <p className="flex items-center gap-2 font-dash text-[16px] font-bold"><Type className="h-4 w-4" aria-hidden /> Paste text</p>
            <Field label="Title"><input className={FIELD} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="Text"><textarea className={TEXTAREA} rows={5} value={text} onChange={(e) => setText(e.target.value)} /></Field>
            <div><Button variant="outline" size="lg" disabled={adding !== null || !title.trim() || text.trim().length < 20} onClick={() => void addText()}>{adding === 'text' && <Loader2 className="animate-spin" />} Add text</Button></div>
          </div>
        </div>
      </Section>

      <Section title="Documents">
        {err ? <ErrorBox message={err} onRetry={() => void load()} /> : !docs ? <ListSkeleton rows={2} /> : docs.length === 0 ? (
          <Empty title="No documents yet" body="Add price lists, FAQs or guides this voice guide should know." />
        ) : (
          <ul className="grid gap-2">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5">
                <FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14.5px] font-extrabold text-foreground">{d.title}</p>
                  <p className="text-[13px] font-semibold capitalize text-muted-foreground">{d.kind} · {size(d.bytes)} · {d.chunks} chunks</p>
                  {d.error && <p className="text-[13px] font-bold text-destructive">{d.error}</p>}
                </div>
                <Status s={d.status} />
                <Button size="icon" variant="ghost" className="h-11 w-11" aria-label={`Reindex ${d.title}`} onClick={() => void reindex(d)}><RefreshCw /></Button>
                <Button size="icon" variant="ghost" className="h-11 w-11" aria-label={`Delete ${d.title}`} onClick={() => setDel(d)}><Trash2 /></Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <AlertDialog open={!!del} onOpenChange={(o) => { if (!o) setDel(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>{del?.title} will be removed and the guide will stop using it.</AlertDialogDescription>
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
