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
import { DesiCard, DesiChip, Marigold } from './desi';
import { HINT, LABEL, Section, TEXTAREA, TINT } from './AiKit';

const KINDS: { key: keyof QuickReplies; label: string }[] = [
  { key: 'home', label: 'Home page' },
  { key: 'article', label: 'Article pages' },
  { key: 'event', label: 'Event pages' },
];
const IMG_OK = ['image/jpeg', 'image/png', 'image/webp'];
const digits = (s: string) => s.replace(/\D/g, '');

/* ── spend meter ────────────────────────────────────────────────────────── */
function SpendMeter({ spend }: { spend: AdminAiSpend | null }) {
  if (!spend) return <div className="h-20 animate-pulse rounded-2xl bg-[var(--a-goldtint)] motion-reduce:animate-none" />;
  const pct = Math.max(0, Math.min(100, Math.round(spend.pct)));
  const tone = spend.pct >= 100 ? 'bg-[var(--a-bad)]' : spend.pct >= 80 ? 'bg-[var(--a-saffron)]' : 'bg-[var(--a-peacock)]';
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-dash text-[clamp(34px,22px+2vw,56px)] font-black leading-none tabular-nums text-[var(--a-plum)]">₹{Math.round(spend.cost_rupees).toLocaleString('en-IN')}</span>
        <span className={HINT}>of ₹{spend.cap_rupees.toLocaleString('en-IN')} this month ({spend.month})</span>
      </div>
      <div className="mt-3 h-5 overflow-hidden rounded-full border-2 border-white bg-[#f3e6cf] shadow-inner" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Monthly AI spend">
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
    <Section title="Brand & domain" tone="lav" corner="hibiscus" pattern="dots">
      {err ? <ErrorBox message={err} onRetry={() => void load()} /> : !brand ? <ListSkeleton rows={2} /> : (
        <div className="grid gap-5">
          <p className="text-[16px] font-semibold text-foreground">
            The helper says she works for <b>{brand.current.name}</b> on <b>{brand.current.domain}</b>. Everything customer-visible uses these
            two values, so changing them here re-words the site, the helper and its knowledge.
          </p>
          <div className="grid gap-4 rounded-3xl border-2 border-dashed border-[#c7b6f5] bg-white/80 p-4 sm:grid-cols-2 sm:p-5">
            <div className="grid gap-1.5">
              <Label htmlFor="brand-name" className={LABEL}>New brand name</Label>
              <Input id="brand-name" className="h-11" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="brand-domain" className={LABEL}>New domain</Label>
              <Input id="brand-domain" className="h-11" value={domain} maxLength={120} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" autoCapitalize="off" spellCheck={false} disabled={busy} aria-invalid={domain.trim() !== '' && !domainOk} />
              {domain.trim() !== '' && !domainOk && <p className="text-[14px] font-bold text-destructive">Enter a domain like example.com.</p>}
            </div>
            <div className="sm:col-span-2">
              <Button variant="outline" className="min-h-11 rounded-full" disabled={!canChange || busy} onClick={() => setConfirm(true)}>
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
                  <li key={i} className={cn('rounded-2xl border-2 p-3', c.pass ? TINT.tea : TINT.rani)}>
                    <div className="flex items-start gap-2">
                      {c.pass ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--a-peacock)]" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--a-rani)]" />}
                      <div className="min-w-0">
                        <p className="text-[14px] font-extrabold text-foreground">{c.question}</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-[14px] font-semibold text-muted-foreground">{c.answer}</p>
                      </div>
                      <DesiChip tone={c.pass ? 'tea' : 'rani'} className="ml-auto shrink-0">{c.pass ? 'Pass' : 'Fail'}</DesiChip>
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
                  <li key={i} className="flex items-start gap-2 rounded-2xl border border-[#f3dfb3] bg-[var(--a-goldtint)] px-3 py-2 text-[14px] font-semibold text-foreground">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--a-saffron)]" />{c}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <AlertDialog open={confirm} onOpenChange={setConfirm}>
            <AlertDialogContent className="hf-admin-operations">
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
    <div className="hfa-stack pb-24">
      <div className="grid gap-[clamp(12px,1.2vw,20px)] lg:grid-cols-[minmax(17rem,24rem)_minmax(0,1fr)]">
        {/* The laminated pehchaan card */}
        <section aria-label="Assistant ID card" className="relative min-w-0 self-start overflow-hidden rounded-[28px] border-2 border-[#c7b6f5] bg-[linear-gradient(170deg,#fff_20%,var(--a-lavtint))] shadow-[0_18px_34px_-18px_rgba(74,23,71,.4)]">
          <span className="pointer-events-none absolute -right-5 -top-6 z-0" aria-hidden="true"><Marigold size={104} tone={0} /></span>
          <div className="relative z-10 border-b-2 border-dashed border-[#c7b6f5] bg-[repeating-linear-gradient(135deg,#f1ebff_0_14px,#e6dcff_14px_28px)] px-5 py-3 pr-24">
            <b className="font-dash text-[14px] font-black uppercase tracking-[.08em] text-[var(--a-lav)]">Pehchaan Patra · AI helper</b>
          </div>
          <div className="relative z-10 grid justify-items-center gap-3 px-5 pb-5 pt-5 text-center">
            <Avatar className="h-36 w-36 border-4 border-white shadow-[0_0_0_4px_var(--a-marigold)] sm:h-40 sm:w-40">
              {draft.avatar_url ? <AvatarImage src={draft.avatar_url} alt={`${draft.name} portrait`} /> : null}
              <AvatarFallback className="bg-[var(--a-rani)] font-dash text-[56px] font-black text-white">{(draft.name.trim()[0] ?? 'A').toUpperCase()}</AvatarFallback>
            </Avatar>
            <p className="max-w-full break-words font-dash text-[clamp(28px,20px+1.6vw,44px)] font-black leading-tight text-[var(--a-plum)]">{draft.name.trim() || 'Unnamed'}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {draft.enabled ? <DesiChip tone="tea">On the site</DesiChip> : <DesiChip tone="grey">Switched off</DesiChip>}
              <DesiChip tone="lav">AI helper</DesiChip>
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Upload a photo" />
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" className="min-h-11 rounded-full bg-white" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? <Loader2 className="animate-spin" /> : <Upload />} Upload
              </Button>
              <Button variant="outline" className="min-h-11 rounded-full bg-white" disabled={generating} onClick={() => void generate()}>
                {generating ? <Loader2 className="animate-spin" /> : <Sparkles />} {generating ? 'Generating…' : 'Generate with AI'}
              </Button>
            </div>
            <p className={cn(HINT, 'max-w-[240px]')}>The chat always labels her “AI helper”.</p>
            <div className="flex w-full items-center justify-between gap-4 rounded-2xl border-2 border-white bg-[var(--a-goldtint)] p-3 text-left">
              <div className="min-w-0">
                <p className={LABEL}>Show the assistant on the site</p>
                <p className={HINT}>Switch her off and the chat bubble disappears for visitors.</p>
              </div>
              <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} aria-label="Assistant on or off" />
            </div>
          </div>
        </section>

        <DesiCard title="Name & welcome" tone="rani" corner="hibiscus" note="What visitors see first.">
          <div className="grid gap-4">
            {!draft.flag_enabled && (
              <div role="note" className="flex items-start gap-2 rounded-2xl border-2 border-dashed border-[var(--a-marigold)] bg-[var(--a-goldtint)] p-3 text-[14px] font-semibold text-foreground">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--a-saffron)]" />
                Preeti is also switched off site-wide; ask Claude to turn on the preetiEnabled flag.
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="ai-name" className={LABEL}>Name</Label>
              <Input id="ai-name" value={draft.name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} className="h-12 text-[18px] font-bold" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ai-welcome" className={LABEL}>Welcome message</Label>
              <textarea id="ai-welcome" rows={6} maxLength={1200} value={draft.welcome_text} onChange={(e) => patch({ welcome_text: e.target.value })} className={TEXTAREA} />
              <p className={HINT}>
                Placeholders filled in when she replies: <code>{'{agent}'}</code> her name, <code>{'{brand}'}</code> the brand name,{' '}
                <code>{'{domain}'}</code> the bare domain, <code>{'{site}'}</code> the full https address. Start in Hinglish, then offer other languages.
              </p>
            </div>
            {cands.length > 0 && (
              <div className="rounded-3xl border-2 border-dashed border-[#c7b6f5] bg-white/80 p-4">
                <p className={LABEL}>Pick a portrait</p>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:max-w-md">
                  {cands.map((u) => (
                    <button
                      key={u} type="button" disabled={saving}
                      onClick={() => { void persist({ avatar_url: u }, 'Portrait saved').then(() => setCands([])); }}
                      className="group overflow-hidden rounded-2xl border-4 border-white text-left shadow-[0_0_0_2px_var(--a-marigold)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="Use this portrait"
                    >
                      <img src={u} alt="Generated portrait candidate" className="aspect-square w-full object-cover" loading="lazy" />
                      <span className="block bg-[var(--a-goldtint)] px-2 py-2.5 text-center font-dashbody text-[14px] font-extrabold">Use this one</span>
                    </button>
                  ))}
                </div>
                <Button variant="ghost" className="mt-2 min-h-11" onClick={() => setCands([])}>Dismiss</Button>
              </div>
            )}
          </div>
        </DesiCard>
      </div>

      <Section title="Quick replies" tone="cream" corner="marigold">
        <p className={cn(HINT, 'mb-3')}>The tap-to-send suggestions under the welcome message, per kind of page. Up to 4 each.</p>
        <div className="grid gap-4 md:grid-cols-3">
          {KINDS.map((k, ki) => (
            <div key={k.key} className={cn('grid content-start gap-2 rounded-3xl border-2 p-4', TINT[(['lav', 'gold', 'tea'] as const)[ki % 3]])}>
              <p className="font-dash text-[17px] font-extrabold text-[var(--a-plum)]">{k.label}</p>
              {qr[k.key].map((v, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input className="h-11 bg-white" value={v} maxLength={60} aria-label={`${k.label} quick reply ${i + 1}`} onChange={(e) => setQr(k.key, qr[k.key].map((x, j) => (j === i ? e.target.value : x)))} />
                  <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label="Remove" onClick={() => setQr(k.key, qr[k.key].filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              ))}
              {qr[k.key].length < 4 && (
                <Button variant="outline" className="min-h-11 justify-self-start rounded-full bg-white" onClick={() => setQr(k.key, [...qr[k.key], ''])}><Plus /> Add</Button>
              )}
            </div>
          ))}
        </div>
      </Section>

      <div className="hfa-row">
        <Section title="Human handover & alerts" tone="tea" corner="jasmine">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="ai-support" className={LABEL}>Support WhatsApp</Label>
              <Input id="ai-support" className="h-11 bg-white" inputMode="tel" value={draft.support_whatsapp} onChange={(e) => patch({ support_whatsapp: e.target.value })} placeholder="+91…" aria-invalid={badNumber(draft.support_whatsapp)} />
              <p className={HINT}>Where “Talk to a human” sends visitors.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ai-alert" className={LABEL}>Alert WhatsApp</Label>
              <Input id="ai-alert" className="h-11 bg-white" inputMode="tel" value={draft.alert_whatsapp} onChange={(e) => patch({ alert_whatsapp: e.target.value })} placeholder="+91…" aria-invalid={badNumber(draft.alert_whatsapp)} />
              <p className={HINT}>Gets the message when spend reaches 80% and 100% of the cap.</p>
            </div>
          </div>
        </Section>

        <Section title="Monthly spend" tone="gold" corner="marigold">
          <div className="grid gap-4">
            <SpendMeter spend={spend} />
            <div className="grid gap-1.5 sm:max-w-[240px]">
              <Label htmlFor="ai-cap" className={LABEL}>Monthly cap (₹)</Label>
              <Input id="ai-cap" type="number" inputMode="numeric" min={0} step={100} value={draft.monthly_cap_rupees} onChange={(e) => patch({ monthly_cap_rupees: Number(e.target.value) })} className="h-12 bg-white text-[18px] font-bold tabular-nums" />
            </div>
          </div>
        </Section>
      </div>

      <BrandCard />

      <div className="sticky bottom-[calc(var(--dash-tabbar-h,0px)+12px)] z-10 flex flex-wrap items-center gap-3 rounded-full border-2 border-white bg-[linear-gradient(120deg,var(--a-plum),#8a2b7d)] px-4 py-3 text-white shadow-[0_14px_30px_-12px_rgba(74,23,71,.6)] sm:bottom-4">
        <Button variant="accent" className="min-h-11 rounded-full" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {dirty && <Button variant="ghost" className="min-h-11 rounded-full text-white hover:bg-white/15 hover:text-white" onClick={() => setDraft(saved)} disabled={saving}>Discard</Button>}
        <span className="text-[14px] font-bold">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      </div>
    </div>
  );
}
