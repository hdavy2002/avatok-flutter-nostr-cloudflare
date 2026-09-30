/* AI assistant › Identity — [SAATHUM-PREETI-1 2026-09-30]
 * Name, avatar (upload / Generate with AI), welcome text, quick replies, WhatsApp numbers, on/off,
 * monthly cap + spend meter, and the Brand & domain card (change flow + 10-question check). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plus, Save, Sparkles, Trash2, Upload, XCircle } from 'lucide-react';
import { captureException, capture } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Switch } from '../../components/ui/switch';
import { Avatar, AvatarFallback, AvatarImage } from '../../components/ui/avatar';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { toast } from '../../components/ui/sonner';
import { errMessage } from './adminApi';
import { ErrorBox, ListSkeleton } from './peopleKit';
import {
  aiApi, uploadAvatar, type AdminAiBrand, type AdminAiBrandChangeResult, type AdminAiConfig, type AdminAiSpend, type QuickReplies,
} from './aiApi';
import { HINT, LABEL, Section, TEXTAREA } from './AiKit';

const KINDS: { key: keyof QuickReplies; label: string }[] = [
  { key: 'home', label: 'Home page' },
  { key: 'article', label: 'Article pages' },
  { key: 'event', label: 'Event pages' },
];
const IMG_OK = ['image/jpeg', 'image/png', 'image/webp'];
const digits = (s: string) => s.replace(/\D/g, '');

/* ── spend meter ────────────────────────────────────────────────────────── */
function SpendMeter({ spend }: { spend: AdminAiSpend | null }) {
  if (!spend) return <div className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />;
  const pct = Math.max(0, Math.min(100, Math.round(spend.pct)));
  const tone = spend.pct >= 100 ? 'bg-destructive' : spend.pct >= 80 ? 'bg-grand-gold' : 'bg-accent';
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-dash text-[22px] font-bold tabular-nums text-foreground">₹{Math.round(spend.cost_rupees).toLocaleString('en-IN')}</span>
        <span className={HINT}>of ₹{spend.cap_rupees.toLocaleString('en-IN')} this month ({spend.month})</span>
      </div>
      <div className="mt-2 h-3 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Monthly AI spend">
        <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width: `${pct}%` }} />
      </div>
      <p className={cn(HINT, 'mt-1.5')}>
        {Math.round(spend.pct)}% used · {spend.messages.toLocaleString('en-IN')} messages · {spend.conversations.toLocaleString('en-IN')} conversations
        {spend.pct >= 100 && ' — the cap is reached, so the helper is asking visitors to WhatsApp you.'}
      </p>
    </div>
  );
}

/* ── brand & domain ─────────────────────────────────────────────────────── */
function BrandCard() {
  const [brand, setBrand] = useState<AdminAiBrand | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminAiBrandChangeResult | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try { setBrand(await aiApi.brand()); }
    catch (e) { captureException(e, { where: 'admin_ai_brand_load' }); setErr('Could not load the brand settings.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const domainClean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const domainOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domainClean);
  const canChange = name.trim().length >= 2 && domainOk;

  async function run() {
    setConfirm(false); setBusy(true); setResult(null);
    try {
      const r = await aiApi.changeBrand(name.trim(), domainClean);
      setResult(r);
      capture('admin_ai_brand_change', { ok: r.ok, passed: r.check?.filter((c) => c.pass).length ?? 0, total: r.check?.length ?? 0 });
      if (r.ok) { toast.success('Brand and domain changed'); setName(''); setDomain(''); await load(); }
      else toast.error(r.error ?? 'The change did not go through.');
    } catch (e) {
      captureException(e, { where: 'admin_ai_brand_change' });
      toast.error(errMessage(e, 'Could not change the brand.'));
    } finally { setBusy(false); }
  }

  return (
    <Section title="Brand & domain">
      {err ? <ErrorBox message={err} onRetry={() => void load()} /> : !brand ? <ListSkeleton rows={2} /> : (
        <div className="grid gap-5">
          <p className="text-[15px] font-semibold text-foreground">
            The helper says she works for <b>{brand.current.name}</b> on <b>{brand.current.domain}</b>. Everything customer-visible uses these
            two values, so changing them here re-words the site, the helper and its knowledge.
          </p>
          <div className="grid gap-4 rounded-lg border border-border/70 bg-background p-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="brand-name" className={LABEL}>New brand name</Label>
              <Input id="brand-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="brand-domain" className={LABEL}>New domain</Label>
              <Input id="brand-domain" value={domain} maxLength={120} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" autoCapitalize="off" spellCheck={false} disabled={busy} aria-invalid={domain.trim() !== '' && !domainOk} />
              {domain.trim() !== '' && !domainOk && <p className="text-[13px] font-bold text-destructive">Enter a domain like example.com.</p>}
            </div>
            <div className="sm:col-span-2">
              <Button variant="outline" disabled={!canChange || busy} onClick={() => setConfirm(true)}>
                {busy ? <Loader2 className="animate-spin" /> : null} {busy ? 'Changing and testing…' : 'Change domain'}
              </Button>
            </div>
          </div>

          {result && (
            <div className="grid gap-3" aria-live="polite">
              <h3 className="font-dash text-[17px] font-bold text-foreground">
                Check results ({result.check?.filter((c) => c.pass).length ?? 0} of {result.check?.length ?? 0} passed)
              </h3>
              {result.error && <p className="text-[14px] font-bold text-destructive">{result.error}</p>}
              <ul className="grid gap-2">
                {(result.check ?? []).map((c, i) => (
                  <li key={i} className={cn('rounded-lg border p-3', c.pass ? 'border-accent/40 bg-accent/5' : 'border-destructive/40 bg-destructive/5')}>
                    <div className="flex items-start gap-2">
                      {c.pass ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                      <div className="min-w-0">
                        <p className="text-[14px] font-extrabold text-foreground">{c.question}</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-[14px] font-semibold text-muted-foreground">{c.answer}</p>
                      </div>
                      <Badge variant={c.pass ? 'accent' : 'destructive'} className="ml-auto shrink-0">{c.pass ? 'Pass' : 'Fail'}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="font-dash text-[17px] font-bold text-foreground">Still to change by hand</h3>
            <p className={HINT}>Things the app cannot rename for you (off-code checklist).</p>
            {brand.checklist.length === 0 ? <p className={cn(HINT, 'mt-2')}>Nothing outstanding.</p> : (
              <ul className="mt-2 grid gap-1.5">
                {brand.checklist.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-[14px] font-semibold text-foreground">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-grand-gold" />{c}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <AlertDialog open={confirm} onOpenChange={setConfirm}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Change to {name.trim()} on {domainClean}?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="grid gap-2 text-left">
                    <p>This is what will happen:</p>
                    <ul className="list-disc space-y-1 pl-5">
                      <li>The helper, welcome text and prompts start using the new name and domain straight away.</li>
                      <li>The current name ({brand.current.name}) and domain become a former name. She will never say it, and if asked she will steer the visitor to the new site.</li>
                      <li>Site pages and uploaded files are re-synced into her knowledge. PDF and Word files are flagged for you to review.</li>
                      <li>She is then asked 10 test questions, and you see her answers.</li>
                    </ul>
                    <p>Domains, DNS, email and app stores are not changed by this.</p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void run()}>Yes, change it</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </Section>
  );
}

/* ── identity form ──────────────────────────────────────────────────────── */
export default function AiIdentity() {
  const [saved, setSaved] = useState<AdminAiConfig | null>(null);
  const [draft, setDraft] = useState<AdminAiConfig | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [spend, setSpend] = useState<AdminAiSpend | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [cands, setCands] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    try { const c = await aiApi.config(); setSaved(c); setDraft(c); }
    catch (e) { captureException(e, { where: 'admin_ai_config_load' }); setLoadErr('Could not load the assistant settings.'); }
    aiApi.spend().then(setSpend).catch((e) => captureException(e, { where: 'admin_ai_spend_load' }));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const dirty = useMemo(() => !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const patch = (p: Partial<AdminAiConfig>) => setDraft((d) => (d ? { ...d, ...p } : d));

  if (loadErr) return <ErrorBox message={loadErr} onRetry={() => void load()} />;
  if (!draft || !saved) return <ListSkeleton rows={4} />;

  const qr = draft.quick_replies;
  const setQr = (k: keyof QuickReplies, list: string[]) => patch({ quick_replies: { ...qr, [k]: list } });
  const badNumber = (v: string) => v.trim() !== '' && digits(v).length < 10;

  async function persist(p: Partial<AdminAiConfig>, okMsg: string) {
    setSaving(true);
    try {
      await aiApi.saveConfig(p);
      toast.success(okMsg);
      capture('admin_ai_config_saved', { fields: Object.keys(p).join(',') });
      const fresh = await aiApi.config();
      setSaved(fresh); setDraft(fresh);
      aiApi.spend().then(setSpend).catch((e) => captureException(e, { where: 'admin_ai_spend_load' }));
    } catch (e) {
      captureException(e, { where: 'admin_ai_config_save' });
      toast.error(errMessage(e, 'Could not save.'));
    } finally { setSaving(false); }
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { toast.error('Give the assistant a name.'); return; }
    if (badNumber(draft.support_whatsapp) || badNumber(draft.alert_whatsapp)) { toast.error('Check the WhatsApp numbers: include the country code.'); return; }
    const cap = Math.round(Number(draft.monthly_cap_rupees));
    if (!Number.isFinite(cap) || cap < 0) { toast.error('The monthly cap must be a rupee amount.'); return; }
    await persist({
      name: draft.name.trim(), avatar_url: draft.avatar_url, welcome_text: draft.welcome_text,
      quick_replies: { home: qr.home.map((s) => s.trim()).filter(Boolean), article: qr.article.map((s) => s.trim()).filter(Boolean), event: qr.event.map((s) => s.trim()).filter(Boolean) },
      support_whatsapp: draft.support_whatsapp.trim(), alert_whatsapp: draft.alert_whatsapp.trim(),
      enabled: draft.enabled, monthly_cap_rupees: cap,
    }, 'Saved');
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!IMG_OK.includes(file.type)) { toast.error('Use a JPG, PNG or WebP image.'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('That image is larger than 5 MB.'); return; }
    setUploading(true);
    try {
      const r = await uploadAvatar(file);
      const url = r.url ?? r.avatar_url;
      if (!url) throw new Error('The upload returned no address.');
      patch({ avatar_url: url });
      toast.success('Photo uploaded', { description: 'Press Save to use it.' });
    } catch (e) {
      captureException(e, { where: 'admin_ai_avatar_upload' });
      toast.error(errMessage(e, 'Could not upload that photo.'));
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function generate() {
    setGenerating(true); setCands([]);
    try {
      const r = await aiApi.generateAvatar();
      setCands(r.candidates ?? []);
      if (!r.candidates?.length) toast.error('No portraits came back. Try again.');
    } catch (e) {
      captureException(e, { where: 'admin_ai_avatar_generate' });
      toast.error(errMessage(e, 'Could not generate portraits.'));
    } finally { setGenerating(false); }
  }

  return (
    <div className="space-y-5 pb-24">
      <Section
        title="Assistant"
        aside={draft.enabled ? <Badge variant="accent">On</Badge> : <Badge variant="muted">Off</Badge>}
      >
        <div className="grid gap-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-background p-3">
            <div>
              <p className={LABEL}>Show the assistant on the site</p>
              <p className={HINT}>Switch her off here and the chat bubble disappears for visitors.</p>
            </div>
            <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} aria-label="Assistant on or off" />
          </div>
          {!draft.flag_enabled && (
            <div role="note" className="flex items-start gap-2 rounded-lg border border-grand-gold/70 bg-grand-gold/20 p-3 text-[14px] font-semibold text-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Preeti is also switched off site-wide; ask Claude to turn on the preetiEnabled flag.
            </div>
          )}

          <div className="grid gap-5 md:grid-cols-[auto_1fr]">
            <div className="grid content-start justify-items-center gap-2">
              <Avatar className="h-28 w-28">
                {draft.avatar_url ? <AvatarImage src={draft.avatar_url} alt={`${draft.name} portrait`} /> : null}
                <AvatarFallback className="font-dash text-[32px]">{(draft.name.trim()[0] ?? 'A').toUpperCase()}</AvatarFallback>
              </Avatar>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Upload a photo" />
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? <Loader2 className="animate-spin" /> : <Upload />} Upload
                </Button>
                <Button size="sm" variant="outline" disabled={generating} onClick={() => void generate()}>
                  {generating ? <Loader2 className="animate-spin" /> : <Sparkles />} {generating ? 'Generating…' : 'Generate with AI'}
                </Button>
              </div>
              <p className={cn(HINT, 'max-w-[220px] text-center')}>The chat always labels her “AI helper”.</p>
            </div>
            <div className="grid content-start gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="ai-name" className={LABEL}>Name</Label>
                <Input id="ai-name" value={draft.name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} className="text-[17px] font-bold" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ai-welcome" className={LABEL}>Welcome message</Label>
                <textarea id="ai-welcome" rows={5} maxLength={1200} value={draft.welcome_text} onChange={(e) => patch({ welcome_text: e.target.value })} className={TEXTAREA} />
                <p className={HINT}>
                  Placeholders filled in when she replies: <code>{'{agent}'}</code> her name, <code>{'{brand}'}</code> the brand name,{' '}
                  <code>{'{domain}'}</code> the bare domain, <code>{'{site}'}</code> the full https address. Start in Hinglish, then offer other languages.
                </p>
              </div>
            </div>
          </div>

          {cands.length > 0 && (
            <div className="rounded-lg border border-border/70 bg-background p-3">
              <p className={LABEL}>Pick a portrait</p>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:max-w-md">
                {cands.map((u) => (
                  <button
                    key={u} type="button" disabled={saving}
                    onClick={() => { void persist({ avatar_url: u }, 'Portrait saved').then(() => setCands([])); }}
                    className="group overflow-hidden rounded-xl border-2 border-border/70 text-left transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Use this portrait"
                  >
                    <img src={u} alt="Generated portrait candidate" className="aspect-square w-full object-cover" loading="lazy" />
                    <span className="block bg-card px-2 py-1.5 text-center font-dashbody text-[13px] font-extrabold">Use this one</span>
                  </button>
                ))}
              </div>
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setCands([])}>Dismiss</Button>
            </div>
          )}
        </div>
      </Section>

      <Section title="Quick replies">
        <p className={cn(HINT, 'mb-3')}>The tap-to-send suggestions under the welcome message, per kind of page. Up to 4 each.</p>
        <div className="grid gap-5 md:grid-cols-3">
          {KINDS.map((k) => (
            <div key={k.key} className="grid content-start gap-2">
              <p className={LABEL}>{k.label}</p>
              {qr[k.key].map((v, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input value={v} maxLength={60} aria-label={`${k.label} quick reply ${i + 1}`} onChange={(e) => setQr(k.key, qr[k.key].map((x, j) => (j === i ? e.target.value : x)))} />
                  <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setQr(k.key, qr[k.key].filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              ))}
              {qr[k.key].length < 4 && (
                <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setQr(k.key, [...qr[k.key], ''])}><Plus /> Add</Button>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Human handover & alerts">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ai-support" className={LABEL}>Support WhatsApp</Label>
            <Input id="ai-support" inputMode="tel" value={draft.support_whatsapp} onChange={(e) => patch({ support_whatsapp: e.target.value })} placeholder="+91…" aria-invalid={badNumber(draft.support_whatsapp)} />
            <p className={HINT}>Where “Talk to a human” sends visitors.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ai-alert" className={LABEL}>Alert WhatsApp</Label>
            <Input id="ai-alert" inputMode="tel" value={draft.alert_whatsapp} onChange={(e) => patch({ alert_whatsapp: e.target.value })} placeholder="+91…" aria-invalid={badNumber(draft.alert_whatsapp)} />
            <p className={HINT}>Gets the message when spend reaches 80% and 100% of the cap.</p>
          </div>
        </div>
      </Section>

      <Section title="Monthly spend">
        <div className="grid gap-4 md:grid-cols-[1fr_220px] md:items-end">
          <SpendMeter spend={spend} />
          <div className="grid gap-1.5">
            <Label htmlFor="ai-cap" className={LABEL}>Monthly cap (₹)</Label>
            <Input id="ai-cap" type="number" inputMode="numeric" min={0} step={100} value={draft.monthly_cap_rupees} onChange={(e) => patch({ monthly_cap_rupees: Number(e.target.value) })} className="text-[17px] font-bold tabular-nums" />
          </div>
        </div>
      </Section>

      <BrandCard />

      <div className="sticky bottom-[calc(var(--dash-tabbar-h,0px)+12px)] z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur sm:bottom-4">
        <Button variant="accent" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {dirty && <Button variant="ghost" onClick={() => setDraft(saved)} disabled={saving}>Discard</Button>}
        <span className="text-[13px] font-semibold text-muted-foreground">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      </div>
    </div>
  );
}
