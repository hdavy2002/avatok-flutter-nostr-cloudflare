/* Voice guides › Card tab — [AUMFE-VOICE-ADMIN-1] create / edit the card fields with a live preview. */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { capture, captureException } from '../../../lib/analytics';
import { Button } from '../../../components/ui/button';
import { toast } from '../../../components/ui/sonner';
import { errMessage } from '../adminApi';
import { CARD } from '../AiKit';
import { HINT, TEXTAREA } from '../AiKit';
import { vgApi, STATUSES, type Guide, type VoiceMeta } from './api';
import { FIELD, Field, GuideCardView, Pick } from './GuideCard';

const BLANK: Guide = {
  id: '', name: '', subject: '', blurb: '', initial: '', tint: '#8a5a2b', avatar_url: '', voice: '', language: '',
  tool_pack: '', price_per_min_tokens: 6, status: 'draft', sort: 100,
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export default function CardTab({ guide, meta, onSaved }: { guide: Guide | null; meta: VoiceMeta | null; onSaved: (g: Guide) => void }) {
  const creating = !guide;
  const [g, setG] = useState<Guide>(() => guide ?? { ...BLANK, voice: meta?.voices[0] ?? '', language: meta?.languages[0] ?? '', tool_pack: meta?.tool_packs[0]?.id ?? '' });
  const [busy, setBusy] = useState(false);
  const [idTouched, setIdTouched] = useState(false);
  const set = (p: Partial<Guide>) => setG((o) => ({ ...o, ...p }));
  const pack = meta?.tool_packs.find((p) => p.id === g.tool_pack);
  const valid = g.name.trim() && /^[a-z0-9][a-z0-9-]{1,39}$/.test(g.id) && g.subject.trim() && g.voice && g.language && g.tool_pack && Number.isInteger(g.price_per_min_tokens) && g.price_per_min_tokens >= 0;

  async function save() {
    setBusy(true);
    const body = {
      name: g.name.trim(), subject: g.subject.trim(), blurb: g.blurb.trim(), initial: (g.initial || g.name.slice(0, 1)).slice(0, 2), tint: g.tint,
      avatar_url: g.avatar_url?.trim() || null, voice: g.voice, language: g.language, tool_pack: g.tool_pack,
      price_per_min_tokens: g.price_per_min_tokens, status: g.status, sort: g.sort,
    } as Partial<Guide>;
    try {
      const r = creating ? await vgApi.create({ id: g.id, ...body }) : await vgApi.update(g.id, body);
      capture('admin_voice_guide_saved', { id: g.id, created: creating, status: g.status });
      toast.success(creating ? 'Voice guide created' : 'Saved');
      onSaved(r.agent ?? { ...g, ...body });
    } catch (e) { captureException(e, { where: 'admin_voice_guide_save' }); toast.error(errMessage(e, 'Could not save the guide.')); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className={`${CARD} grid gap-4`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className={FIELD} value={g.name} maxLength={60} onChange={(e) => set({ name: e.target.value, ...(creating && !idTouched ? { id: slug(e.target.value) } : {}) })} />
          </Field>
          <Field label="Id (web address)" hint={creating ? 'Lowercase letters, numbers and dashes. Cannot change later.' : 'Cannot be changed.'}>
            <input className={FIELD} value={g.id} disabled={!creating} maxLength={40} onChange={(e) => { setIdTouched(true); set({ id: slug(e.target.value) }); }} />
          </Field>
        </div>
        <Field label="Subject"><input className={FIELD} value={g.subject} maxLength={60} placeholder="e.g. Vedic astrology" onChange={(e) => set({ subject: e.target.value })} /></Field>
        <Field label="Blurb" hint="Shown on the customer card."><textarea className={TEXTAREA} rows={3} maxLength={240} value={g.blurb} onChange={(e) => set({ blurb: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Initial"><input className={FIELD} value={g.initial} maxLength={2} onChange={(e) => set({ initial: e.target.value })} /></Field>
          <Field label="Colour">
            <input type="color" aria-label="Colour" className="h-11 w-full cursor-pointer rounded-md border border-input bg-background p-1" value={/^#[0-9a-f]{6}$/i.test(g.tint) ? g.tint : '#8a5a2b'} onChange={(e) => set({ tint: e.target.value })} />
          </Field>
          <Field label="Avatar URL (optional)"><input className={FIELD} value={g.avatar_url ?? ''} inputMode="url" onChange={(e) => set({ avatar_url: e.target.value })} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Voice"><Pick label="Voice" value={g.voice} onChange={(v) => set({ voice: v })} options={(meta?.voices ?? []).map((v) => ({ value: v, label: v }))} /></Field>
          <Field label="Language"><Pick label="Language" value={g.language} onChange={(v) => set({ language: v })} options={(meta?.languages ?? []).map((v) => ({ value: v, label: v }))} /></Field>
        </div>
        <Field label="Tool pack" hint={pack?.description}>
          <Pick label="Tool pack" value={g.tool_pack} onChange={(v) => set({ tool_pack: v })} options={(meta?.tool_packs ?? []).map((p) => ({ value: p.id, label: p.label }))} />
        </Field>
        {pack && pack.tools.length > 0 && (
          <p className={HINT}>Tools: {pack.tools.map((t) => <code key={t} className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-[12.5px]">{t}</code>)}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Price (₹ per minute)" hint="1 token = ₹1">
            <input className={FIELD} type="number" min={0} step={1} inputMode="numeric" value={Number.isFinite(g.price_per_min_tokens) ? g.price_per_min_tokens : ''} onChange={(e) => set({ price_per_min_tokens: e.target.value === '' ? NaN : Math.floor(Number(e.target.value)) })} />
          </Field>
          <Field label="Status"><Pick label="Status" value={g.status} onChange={(v) => set({ status: v as Guide['status'] })} options={STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} /></Field>
          <Field label="Sort order"><input className={FIELD} type="number" step={1} inputMode="numeric" value={g.sort} onChange={(e) => set({ sort: Math.floor(Number(e.target.value) || 0) })} /></Field>
        </div>
        <div><Button variant="accent" size="lg" disabled={!valid || busy} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} {creating ? 'Create guide' : 'Save changes'}</Button></div>
      </div>
      <div className="lg:sticky lg:top-4 lg:self-start">
        <p className="mb-2 font-dashbody text-[14px] font-bold text-muted-foreground">Preview</p>
        <GuideCardView g={g} />
      </div>
    </div>
  );
}
