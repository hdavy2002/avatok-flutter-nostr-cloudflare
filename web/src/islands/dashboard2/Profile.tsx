/* Profile — [DASH2-PROFILE 2026-09-25] Dashboard 2 profile.
 * Contract: Specs/SPEC-2026-09-25-DASHBOARD-2.md (GET/PUT /api/me/profile,
 * /api/me/vpas*, /api/me/phone/*).
 *
 * Six cards, each saved on its own (own Save button + dirty state):
 *   About you · Sankalp defaults · Phone · UPI · Billing & prasad address · Notifications
 * then a Logout button, shown on every size (the phone tab bar has no Logout).
 *
 * The phone change is a Dialog stepper (number -> OTP -> done). The worker swaps
 * numbers in ONE transaction after the new one verifies, so an account never
 * has zero phones; there is deliberately no "delete phone" button.
 *
 * No Clerk provider here (DashNav owns it); the photo is read from the Clerk
 * singleton DashNav loads (window.Clerk), falling back to the profile's photo.
 * Telemetry: dash2_phone_change {step, ok} (plus the worker's own server event).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle, BadgeCheck, Bell, Check, CircleCheckBig, HandHeart, Loader2, LogOut, Mail, MapPin, MessageCircle,
  Phone, Plus, RefreshCw, Smartphone, Star, Trash2, UserRound, Wallet, X,
} from 'lucide-react';
import { capture, captureException } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { Avatar, AvatarFallback, AvatarImage } from '../../components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '../../components/ui/input-otp';
import { toast } from '../../components/ui/sonner';
import { Shimmer } from './Shimmer';
import { errBody, errCode, errMessage, meApi } from './accountApi';
import { DASH_LOGOUT } from './nav';

/* ── types ──────────────────────────────────────────────────────────────── */

type FamilyMember = string | { name: string; relation?: string };
interface Vpa { id: string; vpa: string; is_default: boolean }
interface Address { name: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; pin: string | null; country: string | null }
interface Notify { push: boolean; email: boolean; whatsapp: boolean }
interface Profile {
  name: string | null;
  email: string | null;
  photo_url?: string;
  language?: string;
  gotra?: string;
  family: FamilyMember[];
  phone: { e164_masked: string | null; verified: boolean };
  vpas: Vpa[];
  address?: Address;
  notify: Notify;
}

const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;

const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' }, { code: 'hi', label: 'हिन्दी · Hindi' }, { code: 'mr', label: 'मराठी · Marathi' },
  { code: 'gu', label: 'ગુજરાતી · Gujarati' }, { code: 'bn', label: 'বাংলা · Bengali' }, { code: 'pa', label: 'ਪੰਜਾਬੀ · Punjabi' },
  { code: 'ta', label: 'தமிழ் · Tamil' }, { code: 'te', label: 'తెలుగు · Telugu' }, { code: 'kn', label: 'ಕನ್ನಡ · Kannada' },
  { code: 'ml', label: 'മലയാളം · Malayalam' }, { code: 'or', label: 'ଓଡ଼ିଆ · Odia' }, { code: 'sa', label: 'संस्कृतम् · Sanskrit' },
];

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];

const isIndia = (c: string | null | undefined) => !c || c.trim().toLowerCase() === 'india';

/* ── helpers ────────────────────────────────────────────────────────────── */

/** Draft state for one card; resets to `base` whenever the saved value changes. */
function useDraft<T>(base: T): [T, (v: T | ((c: T) => T)) => void, boolean, () => void] {
  const key = JSON.stringify(base);
  const [draft, setDraft] = useState<T>(base);
  const baseRef = useRef(base);
  baseRef.current = base;
  useEffect(() => { setDraft(JSON.parse(key) as T); }, [key]);
  const dirty = JSON.stringify(draft) !== key;
  return [draft, setDraft, dirty, () => setDraft(baseRef.current)];
}

async function putProfile(patch: Record<string, unknown>): Promise<Profile> {
  return meApi<Profile>('/api/me/profile', { method: 'PUT', body: patch });
}

function FieldError({ msg, id }: { msg?: string; id?: string }) {
  if (!msg) return null;
  return <p id={id} role="alert" className="mt-1.5 flex items-center gap-1 text-[12.5px] font-bold text-primary"><AlertCircle className="h-3.5 w-3.5" />{msg}</p>;
}

function ProfileCard({
  id, icon, title, description, children, dirty, saving, onSave, onReset, footer, saveLabel = 'Save',
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void;
  onReset?: () => void;
  footer?: ReactNode;
  saveLabel?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      id={id}
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.25 }}
      className={cn('dash-surface scroll-mt-24 overflow-hidden transition-shadow', dirty && 'ring-1 ring-grand-gold')}
    >
      <header className="flex items-start gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-dash text-[17px] font-bold leading-tight text-grand-teal">{title}</h2>
          {description && <p className="mt-1 text-[13.5px] font-semibold text-muted-foreground">{description}</p>}
        </div>
        <AnimatePresence>
          {dirty && (
            <motion.span
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="mt-1 hidden rounded-full bg-grand-gold/25 px-2 py-0.5 text-[11px] font-extrabold tracking-[0.06em] text-foreground sm:inline-block"
            >
              Unsaved
            </motion.span>
          )}
        </AnimatePresence>
      </header>
      <div className="px-4 py-4 sm:px-6">{children}</div>
      {(onSave || footer) && (
        <footer className="flex flex-col-reverse gap-2 border-t border-border/40 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-6">
          {footer}
          {onReset && dirty && !saving && <Button variant="ghost" onClick={onReset}>Discard</Button>}
          {onSave && (
            <Button onClick={onSave} disabled={!dirty || saving} variant="accent" className="sm:min-w-[120px]">
              {saving ? <Loader2 className="animate-spin" /> : <Check />} {saving ? 'Saving…' : saveLabel}
            </Button>
          )}
        </footer>
      )}
    </motion.section>
  );
}

/** Save wrapper: PUT, hand back the full profile, map field errors, toast others. */
function useSaver(onSaved: (p: Profile) => void, where: string) {
  const [saving, setSaving] = useState(false);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const save = async (patch: Record<string, unknown>, okMsg: string) => {
    setSaving(true);
    setFieldErr({});
    try {
      const p = await putProfile(patch);
      onSaved(p);
      toast.success(okMsg);
      return true;
    } catch (e) {
      const b = errBody(e);
      if (b.field && b.message) setFieldErr({ [b.field]: b.message });
      else { captureException(e, { where }); toast.error(errMessage(e, 'We could not save that. Please try again.')); }
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { saving, fieldErr, setFieldErr, save };
}

/* ── 1. About you ───────────────────────────────────────────────────────── */

function clerkPhoto(): string | null {
  try {
    const u = (window as unknown as { Clerk?: { user?: { imageUrl?: string; hasImage?: boolean } } }).Clerk?.user;
    return u?.imageUrl ?? null;
  } catch { return null; }
}

function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'S';
}

function AboutCard({ profile, onSaved }: { profile: Profile; onSaved: (p: Profile) => void }) {
  const base = useMemo(() => ({ name: profile.name ?? '', language: profile.language ?? '' }), [profile.name, profile.language]);
  const [d, setD, dirty, reset] = useDraft(base);
  const { saving, fieldErr, setFieldErr, save } = useSaver(onSaved, 'dash2_profile_about');
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    let n = 0;
    const tick = () => { const p = clerkPhoto(); if (p) setPhoto(p); else if (n++ < 20) t = setTimeout(tick, 300); };
    let t = setTimeout(tick, 0);
    return () => clearTimeout(t);
  }, []);
  const img = photo ?? profile.photo_url ?? null;

  const submit = () => {
    const name = d.name.trim();
    if (!name) { setFieldErr({ name: 'Enter your name.' }); return; }
    void save({ name, language: d.language || null }, 'Saved');
  };

  return (
    <ProfileCard icon={<UserRound className="h-5 w-5" />} title="About you" description="How we greet you and address your receipts."
      dirty={dirty} saving={saving} onSave={submit} onReset={reset}>
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="flex items-center gap-3 sm:flex-col sm:items-center">
          <Avatar className="h-20 w-20 ring-2 ring-grand-gold ring-offset-2 ring-offset-card">
            {img && <AvatarImage src={img} alt="" />}
            <AvatarFallback className="font-dash text-[22px] font-bold">{initials(d.name || profile.name)}</AvatarFallback>
          </Avatar>
          <span className="max-w-[140px] text-[11.5px] font-semibold text-muted-foreground sm:text-center">Photo from your sign-in account</span>
        </div>
        <div className="grid flex-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="pf-name" className="text-[13px] font-bold">Name</Label>
            <Input id="pf-name" className="mt-1.5" value={d.name} maxLength={80} autoComplete="name"
              aria-invalid={!!fieldErr.name} aria-describedby={fieldErr.name ? 'pf-name-err' : undefined}
              onChange={(e) => setD({ ...d, name: e.target.value })} />
            <FieldError id="pf-name-err" msg={fieldErr.name} />
          </div>
          <div>
            <Label htmlFor="pf-email" className="text-[13px] font-bold">Email</Label>
            <div className="relative mt-1.5">
              <Input id="pf-email" value={profile.email ?? ''} readOnly disabled className="pr-24 disabled:opacity-80" placeholder="No email" />
              {profile.email && (
                <Badge variant="accent" className="absolute right-2 top-1/2 -translate-y-1/2"><BadgeCheck className="h-3.5 w-3.5" />Verified</Badge>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="pf-lang" className="text-[13px] font-bold">Preferred language</Label>
            <Select value={d.language || 'none'} onValueChange={(v) => setD({ ...d, language: v === 'none' ? '' : v })}>
              <SelectTrigger id="pf-lang" className="mt-1.5"><SelectValue placeholder="Choose a language" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No preference</SelectItem>
                {LANGUAGES.map((l) => <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>)}
                {d.language && !LANGUAGES.some((l) => l.code === d.language) && <SelectItem value={d.language}>{d.language}</SelectItem>}
              </SelectContent>
            </Select>
            <FieldError msg={fieldErr.language} />
          </div>
        </div>
      </div>
    </ProfileCard>
  );
}

/* ── 2. Sankalp defaults ────────────────────────────────────────────────── */

interface FamRow { key: string; name: string; relation: string }
let famSeq = 0;
const famRow = (m: FamilyMember): FamRow =>
  typeof m === 'string' ? { key: `f${famSeq++}`, name: m, relation: '' } : { key: `f${famSeq++}`, name: m.name, relation: m.relation ?? '' };

function SankalpCard({ profile, onSaved }: { profile: Profile; onSaved: (p: Profile) => void }) {
  const reduce = useReducedMotion();
  const base = useMemo(() => ({
    gotra: profile.gotra ?? '',
    family: (profile.family ?? []).map((m) => (typeof m === 'string' ? { name: m, relation: '' } : { name: m.name, relation: m.relation ?? '' })),
  }), [profile.gotra, profile.family]);
  const [d, setD, dirty, reset] = useDraft(base);
  // Stable React keys for the rows (the draft itself holds plain values).
  const [keys, setKeys] = useState<string[]>(() => d.family.map(() => famRow('').key));
  useEffect(() => { setKeys((k) => (k.length === d.family.length ? k : d.family.map((_, i) => k[i] ?? famRow('').key))); }, [d.family]);
  const { saving, fieldErr, setFieldErr, save } = useSaver(onSaved, 'dash2_profile_sankalp');

  const setMember = (i: number, p: Partial<{ name: string; relation: string }>) =>
    setD((c) => ({ ...c, family: c.family.map((m, j) => (j === i ? { ...m, ...p } : m)) }));
  const add = () => { if (d.family.length < 20) { setKeys((k) => [...k, famRow('').key]); setD((c) => ({ ...c, family: [...c.family, { name: '', relation: '' }] })); } };
  const remove = (i: number) => { setKeys((k) => k.filter((_, j) => j !== i)); setD((c) => ({ ...c, family: c.family.filter((_, j) => j !== i) })); };

  const submit = () => {
    const family = d.family
      .map((m) => ({ name: m.name.trim(), relation: m.relation.trim() }))
      .filter((m) => m.name)
      .map((m) => (m.relation ? { name: m.name, relation: m.relation } : m.name));
    setFieldErr({});
    void save({ gotra: d.gotra.trim() || null, family }, 'Sankalp details saved');
  };

  return (
    <ProfileCard icon={<HandHeart className="h-5 w-5" />} title="Sankalp defaults"
      description="The pandit reads these in the sankalp. We fill them in for you when you book."
      dirty={dirty} saving={saving} onSave={submit} onReset={reset}>
      <div className="space-y-5">
        <div className="max-w-md">
          <Label htmlFor="pf-gotra" className="text-[13px] font-bold">Gotra</Label>
          <Input id="pf-gotra" className="mt-1.5" value={d.gotra} maxLength={60} placeholder="e.g. Kashyap" onChange={(e) => setD({ ...d, gotra: e.target.value })} />
          <FieldError msg={fieldErr.gotra} />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label className="text-[13px] font-bold">Family names</Label>
            <span className="text-[12px] font-semibold text-muted-foreground">{d.family.length}/20</span>
          </div>
          <ul className="mt-2 space-y-2">
            <AnimatePresence initial={false}>
              {d.family.map((m, i) => (
                <motion.li
                  key={keys[i] ?? i}
                  initial={reduce ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={{ duration: reduce ? 0 : 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="flex items-center gap-2 py-0.5">
                    <Input aria-label={`Family member ${i + 1} name`} value={m.name} maxLength={80} placeholder="Name"
                      onChange={(e) => setMember(i, { name: e.target.value })} className="flex-[2]" />
                    <Input aria-label={`Family member ${i + 1} relation`} value={m.relation} maxLength={40} placeholder="Relation (optional)"
                      onChange={(e) => setMember(i, { relation: e.target.value })} className="flex-1" />
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${m.name || `member ${i + 1}`}`} onClick={() => remove(i)} className="shrink-0 text-muted-foreground hover:text-primary">
                      <X />
                    </Button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {!d.family.length && <p className="mt-2 text-[13px] font-semibold text-muted-foreground">Add the people you want included in the sankalp.</p>}
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={add} disabled={d.family.length >= 20}><Plus /> Add a name</Button>
          <FieldError msg={fieldErr.family} />
        </div>
      </div>
    </ProfileCard>
  );
}

/* ── 3. Phone ───────────────────────────────────────────────────────────── */

type PhoneStep = 'number' | 'code' | 'done';

function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const RESEND_GAP_S = 30; // mirrors RESEND_GAP_MS in worker/src/routes/phone_otp.ts

function PhoneDialog({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; onChanged: (phone: Profile['phone']) => void }) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState<PhoneStep>('number');
  const [digits, setDigits] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [newMasked, setNewMasked] = useState<string | null>(null);
  const expiresIn = useCountdown(expiresAt);
  const resendIn = useCountdown(resendAt);

  useEffect(() => {
    if (!open) return;
    setStep('number'); setDigits(''); setCode(''); setErr(''); setBusy(false); setExpiresAt(null); setResendAt(null); setNewMasked(null);
  }, [open]);

  const valid = /^[6-9]\d{9}$/.test(digits);

  const start = async (isResend = false) => {
    if (!valid || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await meApi<{ ok: boolean; expires_in_s: number }>('/api/me/phone/start', { method: 'POST', body: { phone: `+91${digits}` } });
      const now = Date.now();
      setExpiresAt(now + (r.expires_in_s || 600) * 1000);
      setResendAt(now + RESEND_GAP_S * 1000);
      setCode('');
      setStep('code');
      capture('dash2_phone_change', { step: isResend ? 'resend' : 'start', ok: true });
      if (isResend) toast.success('New code sent');
    } catch (e) {
      const c = errCode(e);
      const b = errBody(e);
      if (c === 'too_soon' && typeof b.retry_after_s === 'number') {
        setResendAt(Date.now() + b.retry_after_s * 1000);
        if (isResend) setStep('code');
      }
      capture('dash2_phone_change', { step: isResend ? 'resend' : 'start', ok: false, reason: c ?? 'network' });
      if (!c || !['phone_taken', 'too_many', 'too_soon', 'same_phone', 'invalid_phone'].includes(c)) captureException(e, { where: 'dash2_phone_start' });
      setErr(errMessage(e, 'We could not send the code. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (value = code) => {
    if (!/^\d{6}$/.test(value) || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await meApi<{ ok: boolean; phone: Profile['phone'] }>('/api/me/phone/confirm', { method: 'POST', body: { code: value } });
      capture('dash2_phone_change', { step: 'confirm', ok: true });
      setNewMasked(r.phone?.e164_masked ?? null);
      onChanged(r.phone);
      setStep('done');
    } catch (e) {
      const c = errCode(e);
      capture('dash2_phone_change', { step: 'confirm', ok: false, reason: c ?? 'network', attempts_left: errBody(e).attempts_left ?? null });
      if (!c || !['wrong_code', 'code_expired', 'too_many_attempts', 'phone_taken', 'invalid_code', 'no_code'].includes(c)) captureException(e, { where: 'dash2_phone_confirm' });
      setErr(errMessage(e, 'We could not check the code. Please try again.'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const stepIndex = step === 'number' ? 0 : step === 'code' ? 1 : 2;
  const slide = reduce ? {} : { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -24 } };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle className="font-dash">Change phone number</DialogTitle>
          <DialogDescription className="text-[13.5px]">
            Your current number stays on your account until the new one is verified. Then we swap them in one step, so you are never left without a phone.
          </DialogDescription>
        </DialogHeader>

        <ol aria-label="Progress" className="flex items-center gap-2 py-1">
          {['Number', 'Code', 'Done'].map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-2">
              <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-extrabold transition-colors',
                i < stepIndex ? 'bg-accent text-accent-foreground' : i === stepIndex ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
                aria-current={i === stepIndex ? 'step' : undefined}>
                {i < stepIndex ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn('text-[12.5px] font-bold', i === stepIndex ? 'text-foreground' : 'text-muted-foreground')}>{s}</span>
              {i < 2 && <span aria-hidden className={cn('h-0.5 flex-1 rounded-full', i < stepIndex ? 'bg-accent' : 'bg-muted')} />}
            </li>
          ))}
        </ol>

        <div className="min-h-[190px]">
          <AnimatePresence mode="wait" initial={false}>
            {step === 'number' && (
              <motion.form key="number" {...slide} transition={{ duration: 0.18 }} onSubmit={(e) => { e.preventDefault(); void start(); }} className="space-y-3">
                <Label htmlFor="ph-new" className="text-[13px] font-bold">New mobile number</Label>
                <div className="flex">
                  <span className="flex h-11 items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-[15px] font-extrabold text-muted-foreground">+91</span>
                  <Input id="ph-new" inputMode="numeric" autoComplete="tel-national" autoFocus placeholder="98765 43210"
                    value={digits} onChange={(e) => { setDigits(e.target.value.replace(/\D/g, '').slice(-10)); setErr(''); }}
                    className="rounded-l-none text-[16px] font-bold tracking-[0.08em]" aria-invalid={!!err} aria-describedby="ph-err" />
                </div>
                {digits.length === 10 && !valid && <FieldError msg="Indian mobile numbers start with 6, 7, 8 or 9." />}
                <FieldError id="ph-err" msg={err} />
                <p className="text-[12.5px] font-semibold text-muted-foreground">We’ll text a 6-digit code to this number.</p>
                <Button type="submit" variant="accent" className="w-full" disabled={!valid || busy || resendIn > 0}>
                  {busy ? <Loader2 className="animate-spin" /> : <Smartphone />} {resendIn > 0 ? `Send code in ${resendIn}s` : 'Send code'}
                </Button>
              </motion.form>
            )}
            {step === 'code' && (
              <motion.div key="code" {...slide} transition={{ duration: 0.18 }} className="space-y-3">
                <p className="text-[14px] font-semibold text-foreground">
                  Enter the code sent to <strong className="font-extrabold tracking-[0.04em]">+91 {digits.slice(0, 5)} {digits.slice(5)}</strong>
                  <button type="button" className="ml-2 text-[13px] font-bold text-accent underline underline-offset-2" onClick={() => { setStep('number'); setErr(''); }}>Change</button>
                </p>
                <div className="flex justify-center py-1">
                  <InputOTP maxLength={6} value={code} autoFocus inputMode="numeric" autoComplete="one-time-code" disabled={busy}
                    onChange={(v) => { setCode(v); setErr(''); }} onComplete={(v: string) => void confirm(v)} aria-label="6-digit code">
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                <FieldError msg={err} />
                <div className="flex items-center justify-between text-[12.5px] font-semibold text-muted-foreground">
                  <span>{expiresIn > 0 ? `Code expires in ${mmss(expiresIn)}` : 'Code expired — ask for a new one'}</span>
                  <button type="button" disabled={resendIn > 0 || busy} onClick={() => void start(true)}
                    className="font-bold text-accent underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline">
                    {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                  </button>
                </div>
                <Button variant="accent" className="w-full" disabled={code.length !== 6 || busy} onClick={() => void confirm()}>
                  {busy ? <Loader2 className="animate-spin" /> : <Check />} Verify
                </Button>
              </motion.div>
            )}
            {step === 'done' && (
              <motion.div key="done" {...slide} transition={{ duration: 0.18 }} className="flex flex-col items-center py-4 text-center">
                <motion.span
                  initial={reduce ? false : { scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                  transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 18 }}
                  className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-[var(--dash-shadow-lg)]"
                >
                  <CircleCheckBig className="h-8 w-8" />
                </motion.span>
                <h3 className="font-dash text-[17px] font-bold text-grand-teal">Number changed</h3>
                <p className="mt-1 text-[14px] font-semibold text-muted-foreground">
                  {newMasked ? <>Your phone is now <strong className="text-foreground">{newMasked}</strong>. The old number was removed.</> : 'Your new number is verified. The old number was removed.'}
                </p>
                <Button className="mt-5 w-full" variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PhoneCard({ profile, onPhone }: { profile: Profile; onPhone: (p: Profile['phone']) => void }) {
  const [open, setOpen] = useState(false);
  const has = !!profile.phone?.e164_masked;
  return (
    <ProfileCard id="phone" icon={<Phone className="h-5 w-5" />} title="Phone" description="Used to sign in and for booking updates.">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="font-dash text-[18px] font-bold tracking-[0.06em] text-foreground">{has ? profile.phone.e164_masked : 'No phone yet'}</span>
          {has && profile.phone.verified && <Badge variant="accent"><BadgeCheck className="h-3.5 w-3.5" />Verified</Badge>}
        </div>
        <Button variant="outline" onClick={() => { capture('dash2_phone_change', { step: 'open', ok: true }); setOpen(true); }}>
          <Smartphone /> {has ? 'Change number' : 'Add number'}
        </Button>
      </div>
      {has && <p className="mt-3 text-[12.5px] font-semibold text-muted-foreground">To remove this number, add a new one first.</p>}
      <PhoneDialog open={open} onOpenChange={setOpen} onChanged={onPhone} />
    </ProfileCard>
  );
}

/* ── 4. UPI ─────────────────────────────────────────────────────────────── */

function UpiCard({ profile, onVpas }: { profile: Profile; onVpas: (v: Vpa[]) => void }) {
  const reduce = useReducedMotion();
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const add = async () => {
    const v = value.trim();
    if (!VPA_RE.test(v)) { setErr('Enter a valid UPI id, like name@bank.'); return; }
    setAdding(true); setErr('');
    try {
      const r = await meApi<{ vpas: Vpa[] }>('/api/me/vpas', { method: 'POST', body: { vpa: v } });
      onVpas(r.vpas);
      setValue('');
      toast.success('UPI id added');
    } catch (e) {
      const b = errBody(e);
      if (b.field === 'vpa' && b.message) setErr(b.message);
      else { captureException(e, { where: 'dash2_vpa_add' }); toast.error(errMessage(e)); }
    } finally {
      setAdding(false);
    }
  };
  const act = async (id: string, kind: 'default' | 'remove') => {
    setBusyId(id);
    try {
      const r = kind === 'default'
        ? await meApi<{ vpas: Vpa[] }>(`/api/me/vpas/${encodeURIComponent(id)}/default`, { method: 'POST' })
        : await meApi<{ vpas: Vpa[] }>(`/api/me/vpas/${encodeURIComponent(id)}`, { method: 'DELETE' });
      onVpas(r.vpas);
      toast.success(kind === 'default' ? 'Default UPI id updated' : 'UPI id removed');
    } catch (e) {
      captureException(e, { where: `dash2_vpa_${kind}` });
      toast.error(errMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ProfileCard id="upi" icon={<Wallet className="h-5 w-5" />} title="UPI ids" description="Refunds go to your default UPI id.">
      {profile.vpas.length ? (
        <ul className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/40">
          <AnimatePresence initial={false}>
            {profile.vpas.map((v) => (
              <motion.li key={v.id} layout={!reduce}
                initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: reduce ? 0 : 0.18 }} className="overflow-hidden bg-background/60">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:flex-nowrap">
                  <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-foreground">{v.vpa}</span>
                  {v.is_default ? (
                    <Badge variant="accent"><Star className="h-3 w-3 fill-current" />Default</Badge>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={busyId === v.id} onClick={() => void act(v.id, 'default')}>
                      {busyId === v.id ? <Loader2 className="animate-spin" /> : <Star />} Make default
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" aria-label={`Remove ${v.vpa}`} disabled={busyId === v.id} onClick={() => void act(v.id, 'remove')} className="h-9 w-9 text-muted-foreground hover:text-primary">
                    <Trash2 />
                  </Button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-5 text-center text-[13.5px] font-semibold text-muted-foreground">
          No UPI id saved yet. Add one so a refund can reach you.
        </p>
      )}
      <form className="mt-4" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Label htmlFor="upi-new" className="text-[13px] font-bold">Add a UPI id</Label>
        <div className="mt-1.5 flex gap-2">
          <Input id="upi-new" value={value} placeholder="name@bank" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={321}
            aria-invalid={!!err} aria-describedby={err ? 'upi-err' : undefined}
            onChange={(e) => { setValue(e.target.value.replace(/\s/g, '')); setErr(''); }} />
          <Button type="submit" variant="accent" disabled={!value.trim() || adding} className="shrink-0">
            {adding ? <Loader2 className="animate-spin" /> : <Plus />} Add
          </Button>
        </div>
        <FieldError id="upi-err" msg={err} />
      </form>
    </ProfileCard>
  );
}

/* ── 5. Address ─────────────────────────────────────────────────────────── */

function AddressCard({ profile, onSaved }: { profile: Profile; onSaved: (p: Profile) => void }) {
  const a = profile.address;
  const base = useMemo(() => ({
    name: a?.name ?? '', line1: a?.line1 ?? '', line2: a?.line2 ?? '', city: a?.city ?? '',
    state: a?.state ?? '', pin: a?.pin ?? '', country: a?.country ?? 'India',
  }), [a]);
  const [d, setD, dirty, reset] = useDraft(base);
  const { saving, fieldErr, setFieldErr, save } = useSaver(onSaved, 'dash2_profile_address');
  const [removing, setRemoving] = useState(false);
  const india = isIndia(d.country);
  const up = (p: Partial<typeof d>) => setD((c) => ({ ...c, ...p }));

  const submit = () => {
    const t = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.trim()])) as typeof d;
    const errs: Record<string, string> = {};
    if (!t.name) errs['address.name'] = 'Enter the name for delivery.';
    if (!t.line1) errs['address.line1'] = 'Enter the first address line.';
    if (!t.city) errs['address.city'] = 'Enter the city.';
    if (!t.state) errs['address.state'] = india ? 'Choose a state.' : 'Enter the state or region.';
    if (india && !/^\d{6}$/.test(t.pin)) errs['address.pin'] = 'Enter a 6-digit PIN code.';
    if (!india && t.pin && !/^[0-9A-Za-z -]{3,10}$/.test(t.pin)) errs['address.pin'] = 'Enter a valid postal code.';
    if (!t.country) errs['address.country'] = 'Enter the country.';
    if (Object.keys(errs).length) { setFieldErr(errs); return; }
    void save({ address: { ...t, line2: t.line2 || null, pin: t.pin || null } }, 'Address saved');
  };
  const removeAddress = async () => {
    setRemoving(true);
    const ok = await save({ address: null }, 'Address removed');
    setRemoving(false);
    return ok;
  };

  const F = ({ k, label, children, className }: { k: string; label: string; children: ReactNode; className?: string }) => (
    <div className={className}>
      <Label htmlFor={`ad-${k}`} className="text-[13px] font-bold">{label}</Label>
      <div className="mt-1.5">{children}</div>
      <FieldError id={`ad-${k}-err`} msg={fieldErr[`address.${k}`]} />
    </div>
  );
  const inv = (k: string) => ({ 'aria-invalid': !!fieldErr[`address.${k}`], 'aria-describedby': fieldErr[`address.${k}`] ? `ad-${k}-err` : undefined });

  return (
    <ProfileCard id="address" icon={<MapPin className="h-5 w-5" />} title="Billing & prasad address"
      description="Printed on your receipts, and where we send prasad."
      dirty={dirty} saving={saving || removing} onSave={submit} onReset={reset}
      footer={a && !dirty ? (
        <Button variant="ghost" className="text-primary sm:mr-auto" disabled={saving || removing} onClick={() => void removeAddress()}>
          {removing ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove address
        </Button>
      ) : undefined}>
      <div className="grid gap-4 sm:grid-cols-2">
        {F({ k: 'name', label: 'Full name', className: 'sm:col-span-2', children: <Input id="ad-name" autoComplete="name" maxLength={80} value={d.name} onChange={(e) => up({ name: e.target.value })} {...inv('name')} /> })}
        {F({ k: 'line1', label: 'Address line 1', className: 'sm:col-span-2', children: <Input id="ad-line1" autoComplete="address-line1" maxLength={120} placeholder="House / flat, street" value={d.line1} onChange={(e) => up({ line1: e.target.value })} {...inv('line1')} /> })}
        {F({ k: 'line2', label: 'Address line 2 (optional)', className: 'sm:col-span-2', children: <Input id="ad-line2" autoComplete="address-line2" maxLength={120} placeholder="Area, landmark" value={d.line2} onChange={(e) => up({ line2: e.target.value })} /> })}
        {F({ k: 'city', label: 'City', children: <Input id="ad-city" autoComplete="address-level2" maxLength={60} value={d.city} onChange={(e) => up({ city: e.target.value })} {...inv('city')} /> })}
        {F({
          k: 'state', label: india ? 'State / UT' : 'State / region', children: india ? (
            <Select value={INDIAN_STATES.includes(d.state) ? d.state : undefined} onValueChange={(v) => up({ state: v })}>
              <SelectTrigger id="ad-state" {...inv('state')}><SelectValue placeholder={d.state || 'Choose a state'} /></SelectTrigger>
              <SelectContent className="max-h-72">{INDIAN_STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <Input id="ad-state" autoComplete="address-level1" maxLength={60} value={d.state} onChange={(e) => up({ state: e.target.value })} {...inv('state')} />
          ),
        })}
        {F({ k: 'pin', label: india ? 'PIN code' : 'Postal code', children: <Input id="ad-pin" autoComplete="postal-code" inputMode={india ? 'numeric' : 'text'} maxLength={india ? 6 : 10} value={d.pin} onChange={(e) => up({ pin: india ? e.target.value.replace(/\D/g, '') : e.target.value })} {...inv('pin')} /> })}
        {F({ k: 'country', label: 'Country', children: <Input id="ad-country" autoComplete="country-name" maxLength={60} value={d.country} onChange={(e) => { const c = e.target.value; up({ country: c, ...(isIndia(c) !== india ? { state: '' } : {}) }); }} {...inv('country')} /> })}
      </div>
    </ProfileCard>
  );
}

/* ── 6. Notifications ───────────────────────────────────────────────────── */

function NotifyCard({ profile, onSaved }: { profile: Profile; onSaved: (p: Profile) => void }) {
  const base = useMemo(() => ({ push: !!profile.notify?.push, email: !!profile.notify?.email, whatsapp: !!profile.notify?.whatsapp }), [profile.notify]);
  const [d, setD, dirty, reset] = useDraft(base);
  const { saving, save } = useSaver(onSaved, 'dash2_profile_notify');
  const rows: { k: keyof Notify; icon: ReactNode; title: string; body: string }[] = [
    { k: 'push', icon: <Bell className="h-4 w-4" />, title: 'Push notifications', body: 'Reminders on this device before your ritual goes live.' },
    { k: 'email', icon: <Mail className="h-4 w-4" />, title: 'Email', body: 'Booking confirmations, receipts and refund updates.' },
    { k: 'whatsapp', icon: <MessageCircle className="h-4 w-4" />, title: 'WhatsApp', body: 'Join links and reminders on WhatsApp.' },
  ];
  return (
    <ProfileCard icon={<Bell className="h-5 w-5" />} title="Notifications" description="Choose how we reach you."
      dirty={dirty} saving={saving} onSave={() => void save({ notify: d }, 'Notification settings saved')} onReset={reset}>
      <ul className="divide-y divide-border/40">
        {rows.map((r) => (
          <li key={r.k} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/80">{r.icon}</span>
            <div className="min-w-0 flex-1">
              <label htmlFor={`nt-${r.k}`} className="block cursor-pointer text-[14.5px] font-extrabold text-foreground">{r.title}</label>
              <p className="text-[12.5px] font-semibold text-muted-foreground">{r.body}</p>
            </div>
            <Switch id={`nt-${r.k}`} checked={d[r.k]} onCheckedChange={(v) => setD({ ...d, [r.k]: v })} />
          </li>
        ))}
      </ul>
    </ProfileCard>
  );
}

/* ── states ─────────────────────────────────────────────────────────────── */

function ProfileSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading your profile">
      {[0, 1, 2].map((i) => (
        <div key={i} className="dash-surface space-y-4 p-5 sm:p-6">
          <div className="flex items-center gap-3"><Shimmer className="h-10 w-10 rounded-xl" /><div className="flex-1 space-y-2"><Shimmer className="h-4 w-40" /><Shimmer className="h-3 w-64 max-w-full" /></div></div>
          <div className="grid gap-3 sm:grid-cols-2"><Shimmer className="h-11" /><Shimmer className="h-11" /></div>
        </div>
      ))}
    </div>
  );
}

function LogoutButton() {
  return (
    <Button asChild variant="outline" size="lg" className="w-full border-primary/40 text-primary hover:bg-primary/10 sm:w-auto">
      <a href={DASH_LOGOUT.href}><LogOut /> {DASH_LOGOUT.label}</a>
    </Button>
  );
}

/* ── screen ─────────────────────────────────────────────────────────────── */

export default function Profile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const p = await meApi<Profile>('/api/me/profile');
      setProfile({ ...p, family: p.family ?? [], vpas: p.vpas ?? [], notify: p.notify ?? { push: false, email: true, whatsapp: false } });
      setPhase('ready');
    } catch (e) {
      captureException(e, { where: 'dash2_profile_load' });
      setError(errMessage(e));
      setPhase('error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Deep links (/dashboard/profile#upi) land on the card once it exists.
  useEffect(() => {
    if (phase !== 'ready' || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    el?.scrollIntoView({ block: 'start' });
  }, [phase]);

  const saved = useCallback((p: Profile) => setProfile((cur) => ({ ...(cur ?? p), ...p })), []);

  return (
    <div className="space-y-5 font-dashbody">
      {phase === 'loading' && <ProfileSkeleton />}
      {phase === 'error' && (
        <div role="alert" className="dash-surface flex flex-col items-center px-6 py-10 text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><AlertCircle className="h-7 w-7" /></span>
          <h2 className="font-dash text-[17px] font-bold text-foreground">We couldn’t load your profile</h2>
          <p className="mt-2 max-w-sm text-[14px] font-semibold text-muted-foreground">{error}</p>
          <Button className="mt-5" variant="outline" onClick={() => void load()}><RefreshCw /> Try again</Button>
        </div>
      )}
      {phase === 'ready' && profile && (
        <>
          <AboutCard profile={profile} onSaved={saved} />
          <SankalpCard profile={profile} onSaved={saved} />
          <PhoneCard profile={profile} onPhone={(phone) => setProfile((c) => (c ? { ...c, phone } : c))} />
          <UpiCard profile={profile} onVpas={(vpas) => setProfile((c) => (c ? { ...c, vpas } : c))} />
          <AddressCard profile={profile} onSaved={saved} />
          <NotifyCard profile={profile} onSaved={saved} />
        </>
      )}
      <div className="flex justify-center pt-2 sm:justify-start">
        <LogoutButton />
      </div>
    </div>
  );
}
