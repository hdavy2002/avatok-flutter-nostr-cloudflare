/* Voice guides › Persona & prompt — [AUMFE-VOICE-ADMIN-1] versions, new draft, publish. */
import { useCallback, useEffect, useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../../components/ui/alert-dialog';
import { toast } from '../../../components/ui/sonner';
import { errMessage, istDateTime } from '../adminApi';
import { Empty, ErrorBox, ListSkeleton } from '../peopleKit';
import { HINT, Section, TEXTAREA } from '../AiKit';
import { vgApi, type Guide, type GuidePrompt } from './api';
import { FIELD, Field } from './GuideCard';

export default function PromptTab({ guide, onGuide }: { guide: Guide; onGuide: (g: Guide) => void }) {
  const [list, setList] = useState<GuidePrompt[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [persona, setPersona] = useState('');
  const [greeting, setGreeting] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [pub, setPub] = useState<GuidePrompt | null>(null);

  const load = useCallback(async () => {
    try { setList(await vgApi.prompts(guide.id)); setErr(null); }
    catch (e) { captureException(e, { where: 'admin_voice_prompts_load' }); setErr(errMessage(e, 'Could not load the prompts.')); }
  }, [guide.id]);
  useEffect(() => { void load(); }, [load]);

  async function saveDraft() {
    setBusy(true);
    try {
      await vgApi.savePrompt(guide.id, { persona: persona.trim(), greeting: greeting.trim() || undefined, note: note.trim() || undefined });
      toast.success('Draft saved');
      setPersona(''); setGreeting(''); setNote('');
      await load();
    } catch (e) { captureException(e, { where: 'admin_voice_prompt_save' }); toast.error(errMessage(e, 'Could not save the draft.')); }
    finally { setBusy(false); }
  }
  async function publish(p: GuidePrompt) {
    setPub(null); setBusy(true);
    try {
      const r = await vgApi.publish(guide.id, p.id);
      capture('admin_voice_prompt_published', { id: guide.id, version: p.version });
      toast.success(`Version ${p.version} is live`);
      if (r.agent) onGuide(r.agent);
      await load();
    } catch (e) { captureException(e, { where: 'admin_voice_prompt_publish' }); toast.error(errMessage(e, 'Could not publish.')); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <Section title="New version">
        <p className="mb-3 flex items-start gap-2 text-[13.5px] font-semibold text-muted-foreground"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Core safety rules and the tool pack's rules are added automatically.</p>
        <div className="grid gap-4">
          <Field label="Persona and instructions"><textarea className={`${TEXTAREA} min-h-[220px]`} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="Who she is, how she speaks, what she helps with…" /></Field>
          <Field label="Greeting (optional)" hint="The first thing the guide says when the call connects."><textarea className={TEXTAREA} rows={2} value={greeting} onChange={(e) => setGreeting(e.target.value)} /></Field>
          <Field label="Note (optional)"><input className={FIELD} value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this version" /></Field>
          <div><Button variant="outline" size="lg" disabled={busy || persona.trim().length < 20} onClick={() => void saveDraft()}>{busy && <Loader2 className="animate-spin" />} Save draft</Button></div>
        </div>
      </Section>

      <Section title="Versions" aside={<span className={HINT}>Live: {guide.published_prompt_version ? `version ${guide.published_prompt_version}` : 'none yet'}</span>}>
        {err ? <ErrorBox message={err} onRetry={() => void load()} /> : !list ? <ListSkeleton rows={2} /> : list.length === 0 ? <Empty title="No versions yet" body="Write the persona above and save a draft." /> : (
          <ul className="grid gap-2">
            {list.map((p) => (
              <li key={p.id} className="grid gap-2 rounded-lg border border-border/70 bg-background px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-dash text-[16px] font-bold text-foreground">Version {p.version}</span>
                  <Badge variant={p.status === 'published' || p.status === 'live' ? 'accent' : 'outline'} className="capitalize">{p.status}</Badge>
                  <span className="text-[13px] font-semibold text-muted-foreground">{istDateTime(p.published_at ?? p.created_at)}</span>
                  <span className="flex-1" />
                  <Button size="sm" variant="outline" className="min-h-[44px]" onClick={() => setPersona(p.persona) /* copy into the editor */}>Edit as new</Button>
                  {p.status === 'draft' && <Button size="sm" variant="accent" className="min-h-[44px]" disabled={busy} onClick={() => setPub(p)}>Publish</Button>}
                </div>
                {p.note && <p className="text-[13.5px] font-semibold text-muted-foreground">{p.note}</p>}
                <p className="line-clamp-3 whitespace-pre-wrap text-[14px] font-semibold text-foreground">{p.persona}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <AlertDialog open={!!pub} onOpenChange={(o) => { if (!o) setPub(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish version {pub?.version}?</AlertDialogTitle>
            <AlertDialogDescription>New calls will use this persona straight away. Calls already in progress are not changed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pub && void publish(pub)}>Publish</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
